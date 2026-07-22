/**
 * POST /api/entity/replace-8821
 *
 * Processor-facing: swap the 8821 attached to an EXISTING entity for a new
 * file — the "I uploaded the wrong one" recovery path.
 *
 * Why this exists: Carla DeGuzman (Cal Statewide, 2026-07-22) uploaded the
 * UNSIGNED copy of an 8821, and the order sailed on — auto-assigned to an
 * expert within two minutes, IRS-queued, SLA clock running — with no way for
 * her to correct it. Every self-serve path was closed: the upload flow only
 * creates new orders, and email-intake deliberately matches only entities
 * whose signed_8821_url is NULL, so a signed copy emailed in would land in
 * the unmatched-hold queue. The only fix was emailing Matt. An order with a
 * wrong attachment must be a two-click correction, not a support ticket —
 * an expert calling PPS with an unsigned form is a wasted ~$18.49 call.
 *
 * Body (JSON): { entityId: string, storagePath: string }
 *
 * The file itself goes to storage FIRST via /api/upload/sign-8821 signed
 * slots (same flow as the upload screen) — scanned 8821s routinely exceed
 * Vercel's ~4.5 MB body cap, so routing bytes through this function would
 * resurrect the 413 that blocked Robin. We only accept a storage path here,
 * and only one inside the caller's own client prefix, which the signing
 * route server-assigns — a forged path can't reach another client's files.
 *
 * On replace:
 *  - signed_8821_url is swapped; the old path is kept in
 *    gross_receipts.replaced_8821_history (audit trail, nothing deleted)
 *  - pre-signature statuses advance to 8821_signed; in-flight statuses
 *    (irs_queue, processing) are left alone — the queue position is real
 *  - a status note is posted on the entity so the expert sees the swap in
 *    their normal notes feed
 *  - if an expert is actively assigned, they're emailed directly: the file
 *    they may have already downloaded is stale
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import sgMail from '@sendgrid/mail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Statuses where swapping the 8821 no longer makes sense. */
const LOCKED_STATUSES = ['completed', 'failed'];

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const admin = createAdminClient();
    const { data: profile } = await admin
      .from('profiles')
      .select('role, client_id, full_name')
      .eq('id', user.id)
      .single() as { data: { role: string; client_id: string | null; full_name: string | null } | null };

    if (!profile || !['processor', 'manager', 'admin'].includes(profile.role)) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const body = await request.json().catch(() => null) as
      | { entityId?: unknown; storagePath?: unknown }
      | null;
    const entityId = typeof body?.entityId === 'string' ? body.entityId : null;
    const storagePath = typeof body?.storagePath === 'string' ? body.storagePath : null;
    if (!entityId || !storagePath) {
      return NextResponse.json({ error: 'entityId and storagePath are required' }, { status: 400 });
    }

    const { data: entity } = await admin
      .from('request_entities')
      .select('id, entity_name, status, signed_8821_url, gross_receipts, request_id, requests!inner(id, loan_number, client_id)')
      .eq('id', entityId)
      .single() as { data: any };
    if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

    const entityClientId: string = entity.requests?.client_id;
    const isAdmin = profile.role === 'admin';
    if (!isAdmin && entityClientId !== profile.client_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // The signing route assigns paths under the uploader's own client prefix;
    // anything else is forged or stale. Admins act on the ENTITY's client.
    const requiredPrefix = `${isAdmin ? entityClientId : profile.client_id}/8821/`;
    if (!storagePath.startsWith(requiredPrefix)) {
      return NextResponse.json({ error: 'storagePath is not one of your uploads' }, { status: 400 });
    }

    if (LOCKED_STATUSES.includes(entity.status)) {
      return NextResponse.json(
        { error: `This entity is ${entity.status} — the 8821 can no longer be replaced. Reply to your completion email if something is wrong.` },
        { status: 409 },
      );
    }

    // The file must actually be there — a dangling path would strand the
    // entity worse than the wrong PDF did.
    const { error: statErr } = await admin.storage.from('uploads')
      .createSignedUrl(storagePath, 60);
    if (statErr) {
      return NextResponse.json({ error: 'Uploaded file not found in storage — try the upload again' }, { status: 400 });
    }

    // Swap, preserving the old file in an audit trail on the entity.
    const history = Array.isArray(entity.gross_receipts?.replaced_8821_history)
      ? entity.gross_receipts.replaced_8821_history
      : [];
    if (entity.signed_8821_url) {
      history.push({
        path: entity.signed_8821_url,
        replaced_at: new Date().toISOString(),
        replaced_by: user.id,
      });
    }
    const update: Record<string, any> = {
      signed_8821_url: storagePath,
      gross_receipts: { ...(entity.gross_receipts || {}), replaced_8821_history: history },
    };
    // Pre-signature statuses advance; in-flight ones keep their queue position.
    if (['pending', 'submitted', '8821_sent'].includes(entity.status)) {
      update.status = '8821_signed';
    }
    const { error: upErr } = await admin.from('request_entities').update(update).eq('id', entityId);
    if (upErr) {
      console.error('[replace-8821] update failed:', upErr);
      return NextResponse.json({ error: 'Could not attach the new 8821' }, { status: 500 });
    }

    const actorName = profile.full_name || user.email || 'Processor';

    // Note on the entity — the expert's normal feed, no admin relay.
    try {
      await (admin.from('entity_notes' as any) as any).insert({
        entity_id: entityId,
        author_id: user.id,
        author_role: profile.role,
        author_name: actorName,
        kind: 'status_update',
        body: `Signed 8821 replaced by ${actorName}. The previously attached copy is superseded — download the current file before faxing or calling.`,
      });
    } catch (e) {
      console.warn('[replace-8821] entity note failed (non-fatal):', e);
    }

    // If an expert is actively working this entity, tell them directly —
    // they may have already downloaded the stale file.
    let expertNotified = false;
    try {
      const { data: assignment } = await admin
        .from('expert_assignments')
        .select('expert_id')
        .eq('entity_id', entityId)
        .is('completed_at', null)
        .maybeSingle() as { data: { expert_id: string } | null };
      if (assignment?.expert_id && process.env.SENDGRID_API_KEY) {
        const { data: expert } = await admin
          .from('profiles')
          .select('email, full_name')
          .eq('id', assignment.expert_id)
          .single() as { data: { email: string; full_name: string | null } | null };
        if (expert?.email) {
          sgMail.setApiKey(process.env.SENDGRID_API_KEY);
          await sgMail.send({
            to: expert.email,
            from: { email: process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io', name: 'ModernTax' },
            replyTo: 'matt@moderntax.io',
            subject: `8821 replaced on ${entity.entity_name} — re-download before calling`,
            text: `The signed 8821 on ${entity.entity_name} (loan ${entity.requests?.loan_number || '—'}) was just replaced by ${actorName}.\n\nIf you already downloaded the previous copy, discard it — it was superseded (the original upload was unsigned or incorrect). Download the current file from your assignment card before faxing or calling PPS.\n\n— ModernTax`,
          });
          expertNotified = true;
        }
      }
    } catch (e) {
      console.warn('[replace-8821] expert notification failed (non-fatal):', e);
    }

    await logAuditFromRequest(admin, request, {
      action: '8821_replaced',
      resourceType: 'entity',
      resourceId: entityId,
      userId: user.id,
      userEmail: user.email || undefined,
      details: {
        entity_name: entity.entity_name,
        loan_number: entity.requests?.loan_number || null,
        new_path: storagePath,
        previous_path: entity.signed_8821_url || null,
        status_before: entity.status,
        status_after: update.status || entity.status,
        expert_notified: expertNotified,
      },
    });

    return NextResponse.json({
      success: true,
      status: update.status || entity.status,
      expert_notified: expertNotified,
    });
  } catch (err) {
    console.error('[replace-8821] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
