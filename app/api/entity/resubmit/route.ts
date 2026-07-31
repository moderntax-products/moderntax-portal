/**
 * POST /api/entity/resubmit
 *
 * Processor-facing recovery: after a pull FAILED and the processor has fixed
 * the entity details and/or uploaded a corrected signed 8821, push the entity
 * back into the pipeline for another attempt.
 *
 * We move status to '8821_signed', which the auto-assign-experts cron picks up
 * (it selects status ∈ ['8821_signed','irs_queue'] with a signed 8821), so the
 * entity gets re-assigned and re-pulled with no admin in the loop. A signed
 * 8821 must be on file — without one there is nothing to pull; the processor is
 * told to upload one first (the upload path re-queues on its own).
 *
 * Body (JSON): { entityId: string }
 *
 * Matt 2026-07-31 — from Elena (BFC) / Sonja (Cal Statewide): a failed pull must
 * be a self-serve correct-and-retry, not a support ticket.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

    const body = await request.json().catch(() => null) as { entityId?: unknown } | null;
    const entityId = typeof body?.entityId === 'string' ? body.entityId : null;
    if (!entityId) return NextResponse.json({ error: 'entityId is required' }, { status: 400 });

    const { data: entity } = await admin
      .from('request_entities')
      .select('id, entity_name, status, signed_8821_url, request_id, requests!inner(id, loan_number, client_id, requested_by)')
      .eq('id', entityId)
      .single() as { data: any };
    if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

    // Same-client access; processors limited to their own requests.
    const isAdmin = profile.role === 'admin';
    if (!isAdmin && entity.requests?.client_id !== profile.client_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (profile.role === 'processor' && entity.requests?.requested_by !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Only a failed entity is re-submittable here. (In-flight / completed
    // entities are never in this state; a fresh entity re-enters via the normal
    // 8821 flow, not this route.)
    if (entity.status !== 'failed') {
      return NextResponse.json(
        { error: `This entity is "${entity.status}", not a failed pull — nothing to re-submit.` },
        { status: 409 },
      );
    }

    // Nothing to pull without a signed 8821. The upload path (replace-8821)
    // re-queues on its own, so send them there first.
    if (!entity.signed_8821_url) {
      return NextResponse.json(
        { error: 'Upload a signed 8821 for this entity first, then re-submit.' },
        { status: 400 },
      );
    }

    const { error: upErr } = await admin
      .from('request_entities')
      .update({ status: '8821_signed' })
      .eq('id', entityId);
    if (upErr) {
      console.error('[entity/resubmit] update failed:', upErr);
      return NextResponse.json({ error: 'Could not re-submit this entity' }, { status: 500 });
    }

    const actorName = profile.full_name || user.email || 'Processor';
    try {
      await (admin.from('entity_notes' as any) as any).insert({
        entity_id: entityId,
        author_id: user.id,
        author_role: profile.role,
        author_name: actorName,
        kind: 'status_update',
        body: `Re-submitted for another pull by ${actorName} after a failed attempt. Details/8821 were reviewed; back in the queue for assignment.`,
      });
    } catch (e) {
      console.warn('[entity/resubmit] entity note failed (non-fatal):', e);
    }

    await logAuditFromRequest(admin, request, {
      action: 'entity_resubmitted',
      resourceType: 'entity',
      resourceId: entityId,
      userId: user.id,
      userEmail: user.email || undefined,
      details: {
        entity_name: entity.entity_name,
        loan_number: entity.requests?.loan_number || null,
        status_before: 'failed',
        status_after: '8821_signed',
      },
    });

    return NextResponse.json({ success: true, status: '8821_signed' });
  } catch (err) {
    console.error('[entity/resubmit] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
