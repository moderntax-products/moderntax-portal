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
    const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
    const role = profile?.role;

    // Access gate: admin always OK; expert OK if they have an assignment on this entity
    if (role !== 'admin' && role !== 'expert') {
      return NextResponse.json({ error: 'Admin or expert only' }, { status: 403 });
    }
    if (role === 'expert') {
      const admin = createAdminClient();
      const { data: assn } = await admin.from('expert_assignments')
        .select('id').eq('entity_id', entityId).eq('expert_id', user.id).limit(1)
        .maybeSingle() as { data: any };
      if (!assn) return NextResponse.json({ error: 'No assignment on this entity' }, { status: 403 });
    }

    const admin = createAdminClient();
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

    return NextResponse.json({ notes: data || [] });
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
    const { data: profile } = await sb.from('profiles').select('role, full_name, email').eq('id', user.id).single() as { data: { role: string; full_name: string | null; email: string } | null };
    if (!profile || (profile.role !== 'admin' && profile.role !== 'expert')) {
      return NextResponse.json({ error: 'Admin or expert only' }, { status: 403 });
    }

    let body: { body?: string; kind?: string };
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
    const noteBody = body.body?.trim();
    if (!noteBody) return NextResponse.json({ error: 'body required' }, { status: 400 });
    if (noteBody.length > 4000) return NextResponse.json({ error: 'body max 4000 chars' }, { status: 400 });
    const kind = (body.kind && VALID_KINDS.includes(body.kind)) ? body.kind : 'note';

    const admin = createAdminClient();

    // For experts: confirm they have an assignment on this entity
    if (profile.role === 'expert') {
      const { data: assn } = await admin.from('expert_assignments')
        .select('id').eq('entity_id', entityId).eq('expert_id', user.id).limit(1)
        .maybeSingle() as { data: any };
      if (!assn) return NextResponse.json({ error: 'No assignment on this entity' }, { status: 403 });
    }

    const authorName = profile.full_name || profile.email;
    const { data: inserted, error } = await (admin.from('entity_notes' as any) as any)
      .insert({
        entity_id: entityId,
        author_id: user.id,
        author_role: profile.role,
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
    notifyOpposite(admin, entityId, profile.role, authorName, noteBody, kind).catch((e) =>
      console.warn('[entity-notes] notify failed:', e?.message || e),
    );

    return NextResponse.json({ note: inserted });
  } catch (err: any) {
    console.error('[entity-notes POST]', err);
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 });
  }
}

/**
 * Email the opposite party — admin posts → assigned expert email;
 * expert posts → matt@moderntax.io (admin team).
 */
async function notifyOpposite(
  admin: ReturnType<typeof createAdminClient>,
  entityId: string,
  authorRole: 'admin' | 'expert',
  authorName: string,
  body: string,
  kind: string,
): Promise<void> {
  const sgMod = await import('@sendgrid/mail');
  const sgMail = sgMod.default;
  if (!process.env.SENDGRID_API_KEY) return;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  // Resolve entity + assigned expert for context
  const { data: ent } = await admin.from('request_entities')
    .select('id, entity_name, form_type, requests(loan_number, client_id, clients(name))')
    .eq('id', entityId).single() as { data: any };
  if (!ent) return;
  const { data: assn } = await admin.from('expert_assignments')
    .select('expert_id, profiles!expert_assignments_expert_id_fkey(full_name, email)')
    .eq('entity_id', entityId).in('status', ['assigned', 'in_progress']).limit(1)
    .maybeSingle() as { data: any };

  let toEmail: string | null;
  let toName: string;
  if (authorRole === 'admin') {
    toEmail = assn?.profiles?.email || null;
    toName = assn?.profiles?.full_name || 'Expert';
  } else {
    toEmail = 'matt@moderntax.io';
    toName = 'Matt';
  }
  if (!toEmail) return;

  const portalLink = authorRole === 'admin'
    ? 'https://portal.moderntax.io/expert'
    : `https://portal.moderntax.io/admin/requests/${ent.requests?.id || ''}`;
  const subject = `[Note: ${ent.entity_name}] ${authorName} posted${kind !== 'note' ? ` (${kind})` : ''}`;

  await sgMail.send({
    to: toEmail,
    from: { email: 'no-reply@moderntax.io', name: 'ModernTax Portal' },
    subject,
    text:
`${authorName} (${authorRole}) just added a note to ${ent.entity_name}${ent.requests?.loan_number ? ` (loan ${ent.requests.loan_number})` : ''}:

${body}

Type: ${kind}
Reply on the entity record: ${portalLink}

— ModernTax Portal`,
    html: `
<div style="font-family:-apple-system,sans-serif;max-width:600px;line-height:1.5;color:#1a2845;">
  <p>Hi ${toName.split(' ')[0]},</p>
  <p><strong>${authorName}</strong> just added a ${kind === 'note' ? 'note' : `<em>${kind}</em>`} to <strong>${ent.entity_name}</strong>${ent.requests?.loan_number ? ` (loan ${ent.requests.loan_number})` : ''}:</p>
  <blockquote style="margin:12px 0;padding:12px 16px;background:#f3f4f6;border-left:3px solid #295c9e;color:#1f2937;white-space:pre-wrap;">${body.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]!))}</blockquote>
  <p><a href="${portalLink}" style="color:#295c9e;font-weight:600;">Reply on the entity record →</a></p>
</div>`,
  });
}
