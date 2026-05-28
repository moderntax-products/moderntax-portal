/**
 * GET /api/admin/expert-notes-queue
 *
 * Read-only stream of every expert-authored note across the portal.
 * Replaces the prior auto-email-to-processor channel that used to fire
 * out of /api/entity-notes when an expert posted.
 *
 * Driver: 2026-05-28 Matt — "No expert to processor communication
 * allowed in the system. There should just be a queue in the admin
 * portal for this communications." Lots of false-tone / sensitive
 * expert chatter was reaching client processors as auto-emails (e.g.
 * Joel's PPS hold updates landing in Andrew/Sonja's inbox). Now every
 * expert note funnels through this admin-only queue: admin sees them,
 * processors do not (no email, no portal-thread visibility).
 *
 * Joins enough request context per note for an admin to triage at a
 * glance — entity name + loan + client + form + status, plus a body
 * preview. No DB writes, no email sends — this endpoint is the
 * "inbox", not an action surface.
 *
 * Query params:
 *   ?limit=N            (default 100, max 500)
 *   ?kind=KIND          (filter to one kind, e.g. status_update)
 *   ?client_id=UUID     (filter to one client's entities)
 *   ?since=ISO8601      (only notes created after this timestamp)
 *
 * Auth: admin role only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const sb = createServerRouteClient(cookieStore);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }

  const limitRaw = Number(request.nextUrl.searchParams.get('limit') || 100);
  const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100), 500);
  const kindFilter = request.nextUrl.searchParams.get('kind');
  const clientFilter = request.nextUrl.searchParams.get('client_id');
  const sinceRaw = request.nextUrl.searchParams.get('since');
  const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? new Date(sinceRaw).toISOString() : null;

  const admin = createAdminClient();

  // Pull expert-authored notes joined with entity → request → client.
  // We do this in one round-trip via Supabase's inner-join syntax so
  // we don't N+1 the entity context per note.
  let query: any = admin.from('entity_notes' as any)
    .select(`
      id, entity_id, author_id, author_role, author_name, body, kind, created_at,
      request_entities!inner(
        id, entity_name, form_type, status, tid, tid_kind,
        requests!inner(
          id, loan_number, client_id,
          clients!inner(id, name, slug)
        )
      )
    `)
    .eq('author_role', 'expert')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (kindFilter) query = query.eq('kind', kindFilter);
  if (since) query = query.gte('created_at', since);
  if (clientFilter) {
    // Filter by client via the nested join. Supabase syntax for an
    // inner-joined column predicate.
    query = query.eq('request_entities.requests.client_id', clientFilter);
  }

  const { data, error } = await query as { data: any[] | null; error: any };

  if (error) {
    // Graceful degrade if entity_notes table isn't migrated yet on a
    // fresh env — same pattern as the per-entity GET.
    if (/entity_notes|relation .* does not exist|PGRST/i.test(error.message || '')) {
      return NextResponse.json({ notes: [], migration_pending: true });
    }
    console.error('[expert-notes-queue]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Flatten the join shape so the UI doesn't need to traverse nested
  // objects. Body preview is left full-length; the page caps display.
  const notes = (data || []).map((n: any) => {
    const ent = n.request_entities;
    const req = ent?.requests;
    const client = req?.clients;
    return {
      id: n.id,
      created_at: n.created_at,
      author_id: n.author_id,
      author_name: n.author_name,
      kind: n.kind,
      body: n.body,
      entity_id: n.entity_id,
      entity_name: ent?.entity_name || null,
      entity_form_type: ent?.form_type || null,
      entity_status: ent?.status || null,
      entity_tid: ent?.tid || null,
      entity_tid_kind: ent?.tid_kind || null,
      request_id: req?.id || null,
      loan_number: req?.loan_number || null,
      client_id: client?.id || null,
      client_name: client?.name || null,
      client_slug: client?.slug || null,
    };
  });

  return NextResponse.json({
    notes,
    count: notes.length,
    limit,
    filters: { kind: kindFilter || null, client_id: clientFilter || null, since },
  });
}
