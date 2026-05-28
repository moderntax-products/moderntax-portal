/**
 * Entity notes thread — admin <-> expert ops chatter per entity.
 *
 * GET  /api/entity-notes/[entityId]   List notes (chronological)
 * POST /api/entity-notes/[entityId]   Append a note { body, kind? }
 *
 * Access:
 *   - admin: full read + write on any entity
 *   - expert: read + write only on entities where they have an active
 *     or completed expert_assignment (RLS handles this server-side too)
 *   - everyone else: 403
 *
 * Side effect on POST: emails the OTHER party (if admin posts → email
 * the assigned expert; if expert posts → email matt@moderntax.io).
 * Fire-and-forget; email failure doesn't block the write.
 *
 * Built 2026-05-26 from Joel Abernathy's feedback: per-entity instructions
 * + status updates were trapped in Gmail. Now they live on the entity.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PageProps { params: Promise<{ entityId: string }> }

const VALID_KINDS = ['note', 'instruction', 'status_update', 'question', 'answer'];

export async function GET(_request: NextRequest, { params }: PageProps) {
  try {
    const cookieStore = await cookies();
    const sb = createServerRouteClient(cookieStore);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { entityId } = await params;
    const { data: profile } = await sb.from('profiles').select('role, client_id').eq('id', user.id).single() as { data: { role: string; client_id: string | null } | null };
    const role = profile?.role;

    // Access gate (2026-05-27 widened per Matt's "no admin back-and-forth"
    // directive): admin OR assigned expert OR processor/manager on the
    // entity's client. Same as the RLS policies.
    const admin = createAdminClient();
    if (role !== 'admin' && role !== 'expert' && role !== 'processor' && role !== 'manager') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (role === 'expert') {
      const { data: assn } = await admin.from('expert_assignments')
        .select('id').eq('entity_id', entityId).eq('expert_id', user.id).limit(1)
        .maybeSingle() as { data: any };
      if (!assn) return NextResponse.json({ error: 'No assignment on this entity' }, { status: 403 });
    }
    if (role === 'processor' || role === 'manager') {
      // Must belong to the entity's client
      const { data: ent } = await admin.from('request_entities')
        .select('requests!inner(client_id)')
        .eq('id', entityId).single() as { data: any };
      const entClient = ent?.requests?.client_id;
      if (!entClient || entClient !== profile?.client_id) {
        return NextResponse.json({ error: 'Entity does not belong to your organization' }, { status: 403 });
      }
    }

    const { data, error } = await (admin.from('entity_notes' as any) as any)
      .select('id, author_id, author_role, author_name, body, kind, created_at')
      .eq('entity_id', entityId)
      .order('created_at', { ascending: true });

    // Graceful degrade: if the table doesn't exist yet (migration not applied)
    // return an empty thread instead of 500ing the page.
    if (error && /entity_notes|relation .* does not exist|PGRST/i.test(error.message || '')) {
      return NextResponse.json({ notes: [], migration_pending: true });
    }
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Anonymize + filter cross-org notes on the thread.
    // Driver: 2026-05-28 Matt — note-by-note evolution:
    //   1. Expert-authored notes were originally masked to "ModernTax"
    //      for processor/manager viewers.
    //   2. Processor/manager-authored notes were masked to client name
    //      for expert viewers.
    //   3. Final directive: "No expert to processor communication
    //      allowed in the system." Expert notes are now HIDDEN entirely
    //      from processor/manager viewers — they don't see them in the
    //      portal thread, and they don't get emailed about them either.
    //      Admin reviews them via /admin/expert-notes-queue.
    // Current rules:
    //   - Processor / manager requester → expert-authored notes are
    //     filtered out of the response entirely.
    //   - Expert requester → processor / manager-authored notes show
    //     the client name (e.g. "Centerstone SBA Lending") instead of
    //     the individual.
    //   - Admin sees everything with real names.
    //   - The requester's own posts are never masked.
    const isProcessorLike = role === 'processor' || role === 'manager';
    const isExpert = role === 'expert';
    let clientNameForMask = 'Client';
    if (isExpert) {
      const { data: ctxRow } = await admin.from('request_entities')
        .select('requests!inner(clients(name))')
        .eq('id', entityId).single() as { data: any };
      clientNameForMask = ctxRow?.requests?.clients?.name || 'Client';
    }
    const notes = (data || [])
      // Filter: processors/managers don't see expert notes at all.
      .filter((n: any) => !(isProcessorLike && n.author_role === 'expert'))
      .map((n: any) => {
        // Never mask the requester's own posts.
        if (n.author_id === user.id) return n;
        if (isExpert && (n.author_role === 'processor' || n.author_role === 'manager')) {
          return { ...n, author_name: clientNameForMask, author_id: null };
        }
        return n;
      });

    return NextResponse.json({ notes });
  } catch (err: any) {
    console.error('[entity-notes GET]', err);
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: PageProps) {
  try {
    const cookieStore = await cookies();
    const sb = createServerRouteClient(cookieStore);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { entityId } = await params;
    const { data: profile } = await sb.from('profiles').select('role, full_name, email, client_id').eq('id', user.id).single() as { data: { role: string; full_name: string | null; email: string; client_id: string | null } | null };
    const role = profile?.role;
    if (!profile || !['admin', 'expert', 'processor', 'manager'].includes(role || '')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    let body: { body?: string; kind?: string };
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
    const noteBody = body.body?.trim();
    if (!noteBody) return NextResponse.json({ error: 'body required' }, { status: 400 });
    if (noteBody.length > 4000) return NextResponse.json({ error: 'body max 4000 chars' }, { status: 400 });
    const kind = (body.kind && VALID_KINDS.includes(body.kind)) ? body.kind : 'note';

    const admin = createAdminClient();

    // Access checks per role
    if (role === 'expert') {
      const { data: assn } = await admin.from('expert_assignments')
        .select('id').eq('entity_id', entityId).eq('expert_id', user.id).limit(1)
        .maybeSingle() as { data: any };
      if (!assn) return NextResponse.json({ error: 'No assignment on this entity' }, { status: 403 });
    }
    if (role === 'processor' || role === 'manager') {
      const { data: ent } = await admin.from('request_entities')
        .select('requests!inner(client_id)')
        .eq('id', entityId).single() as { data: any };
      if (ent?.requests?.client_id !== profile.client_id) {
        return NextResponse.json({ error: 'Entity does not belong to your organization' }, { status: 403 });
      }
    }

    const authorName = profile.full_name || profile.email;
    const { data: inserted, error } = await (admin.from('entity_notes' as any) as any)
      .insert({
        entity_id: entityId,
        author_id: user.id,
        author_role: role,
        author_name: authorName,
        body: noteBody,
        kind,
      })
      .select('id, author_id, author_role, author_name, body, kind, created_at')
      .single();
    if (error) {
      // Degrade: migration not applied
      if (/entity_notes|relation .* does not exist|PGRST/i.test(error.message || '')) {
        return NextResponse.json({
          error: 'entity_notes table not yet migrated — paste supabase/migration-entity-notes.sql into Supabase Studio',
          migration_pending: true,
        }, { status: 503 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Fire-and-forget notification to the OTHER party
    notifyOpposite(admin, entityId, role as 'admin' | 'expert' | 'processor' | 'manager', authorName, noteBody, kind).catch((e) =>
      console.warn('[entity-notes] notify failed:', e?.message || e),
    );

    return NextResponse.json({ note: inserted });
  } catch (err: any) {
    console.error('[entity-notes POST]', err);
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 });
  }
}

/**
 * Email routing for note notifications — extended 2026-05-27 for the
 * "no admin back-and-forth" directive:
 *   - processor/manager posts → assigned expert (primary recipient).
 *     If no expert assigned yet, route to matt@moderntax.io as fallback.
 *     Always CC matt@moderntax.io for visibility.
 *   - expert posts → the processor who submitted the original request
 *     (primary recipient). Always CC matt@moderntax.io for visibility.
 *   - admin posts → assigned expert (unchanged).
 *
 * This eliminates the prior "admin must relay" pattern: processor and
 * expert can now exchange instructions + status updates directly.
 */
async function notifyOpposite(
  admin: ReturnType<typeof createAdminClient>,
  entityId: string,
  authorRole: 'admin' | 'expert' | 'processor' | 'manager',
  authorName: string,
  body: string,
  kind: string,
): Promise<void> {
  const sgMod = await import('@sendgrid/mail');
  const sgMail = sgMod.default;
  if (!process.env.SENDGRID_API_KEY) return;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  // Resolve entity + assigned expert + originating processor for context
  const { data: ent } = await admin.from('request_entities')
    .select('id, entity_name, form_type, requests(id, loan_number, client_id, requested_by, profiles!requests_requested_by_fkey(full_name, email), clients(name))')
    .eq('id', entityId).single() as { data: any };
  if (!ent) return;
  const { data: assn } = await admin.from('expert_assignments')
    .select('expert_id, profiles!expert_assignments_expert_id_fkey(full_name, email)')
    .eq('entity_id', entityId).in('status', ['assigned', 'in_progress']).limit(1)
    .maybeSingle() as { data: any };

  const expertEmail = assn?.profiles?.email || null;
  const expertName  = assn?.profiles?.full_name || 'Expert';
  // Originating processor identity is still computed for context but no
  // longer used as a recipient — 2026-05-28 directive sends expert notes
  // only to admin, and processor/manager notes still route directly to
  // the expert (no processor recipient needed in that direction either).
  // Kept commented for documentation; remove the lookup once we're sure
  // no future routing needs it.
  // const processorEmail = ent.requests?.profiles?.email || null;
  // const processorName  = ent.requests?.profiles?.full_name || 'Processor';

  let toEmail: string | null;
  let toName: string;
  const ccEmails: string[] = [];
  if (authorRole === 'admin') {
    toEmail = expertEmail;
    toName = expertName;
  } else if (authorRole === 'expert') {
    // 2026-05-28 Matt — "No expert to processor communication allowed
    // in the system. There should just be a queue in the admin portal
    // for this communications." Expert notes go ONLY to admin; the
    // processor never sees the email (and the GET handler hides
    // expert-authored notes from the processor's portal thread too).
    // Admin reviews everything via /admin/expert-notes-queue.
    toEmail = 'matt@moderntax.io';
    toName = 'Matt';
  } else {
    // Processor / manager → goes to the assigned expert (so they see the
    // intake or clarification directly), CC admin for visibility.
    toEmail = expertEmail || 'matt@moderntax.io';
    toName = expertEmail ? expertName : 'Matt';
    if (expertEmail) ccEmails.push('matt@moderntax.io');
  }
  if (!toEmail) return;

  // Portal link: deep-link to whichever surface the recipient uses
  const portalLink = (authorRole === 'admin' || authorRole === 'processor' || authorRole === 'manager')
    ? 'https://portal.moderntax.io/expert'
    : `https://portal.moderntax.io/request/${ent.requests?.id || ''}`;

  // Anonymize cross-org identities for note notifications.
  // Driver: 2026-05-28 Matt — note-by-note evolution:
  //   1. "Notes from experts should not include expert name on any
  //      processor/manager-facing communications."
  //   2. "Remove all processor tags on entity/expert notes."
  //   3. "No expert to processor communication allowed in the system —
  //      queue in the admin portal."
  // After #3 the expert-author email goes only to admin, so we can
  // safely show the real expert name (admin should know which expert
  // posted). Processor/manager-author emails still go to expert + CC
  // admin, so we mask the processor identity to the client name.
  // Admin-author emails go to expert, real name shown.
  const clientName = ent.requests?.clients?.name || 'Client';
  let displayAuthorName: string;
  let displayRoleSuffix: string;
  if (authorRole === 'processor' || authorRole === 'manager') {
    displayAuthorName = clientName;
    displayRoleSuffix = '';
  } else {
    displayAuthorName = authorName;
    displayRoleSuffix = ` (${authorRole})`;
  }
  const subject = `[Note: ${ent.entity_name}] ${displayAuthorName} posted${kind !== 'note' ? ` (${kind})` : ''}`;

  await sgMail.send({
    to: toEmail,
    cc: ccEmails.length > 0 ? ccEmails : undefined,
    from: { email: 'no-reply@moderntax.io', name: 'ModernTax Portal' },
    subject,
    text:
`${displayAuthorName}${displayRoleSuffix} just added a note to ${ent.entity_name}${ent.requests?.loan_number ? ` (loan ${ent.requests.loan_number})` : ''}:

${body}

Type: ${kind}
Reply on the entity record: ${portalLink}

— ModernTax Portal`,
    html: `
<div style="font-family:-apple-system,sans-serif;max-width:600px;line-height:1.5;color:#1a2845;">
  <p>Hi ${toName.split(' ')[0]},</p>
  <p><strong>${displayAuthorName}</strong> just added a ${kind === 'note' ? 'note' : `<em>${kind}</em>`} to <strong>${ent.entity_name}</strong>${ent.requests?.loan_number ? ` (loan ${ent.requests.loan_number})` : ''}:</p>
  <blockquote style="margin:12px 0;padding:12px 16px;background:#f3f4f6;border-left:3px solid #295c9e;color:#1f2937;white-space:pre-wrap;">${body.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]!))}</blockquote>
  <p><a href="${portalLink}" style="color:#295c9e;font-weight:600;">Reply on the entity record →</a></p>
</div>`,
  });
}
