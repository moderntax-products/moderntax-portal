/**
 * POST /api/intake/post-intake-notes
 *
 * Server-side hook for client components that create requests + entities
 * directly via the Supabase JS client (ManualEntryFlow, etc.). After the
 * client inserts the rows, it calls this endpoint with `{ request_id }`
 * — we look up every entity on the request and fire the intake-note
 * autopost helper per entity using the caller's auth.
 *
 * Why this exists separately from the CSV / PDF intakes: those run fully
 * server-side and call autoPostIntakeNote inline. ManualEntryFlow's
 * insert path is client-side (RLS-gated), so the autopost has to be
 * invoked via a small companion route that the client triggers after a
 * successful insert.
 *
 * Driver: 2026-05-27 Matt "no admin back-and-forth" directive — every
 * intake path must produce the per-entity instruction note for the expert.
 *
 * Idempotent (relies on autoPostIntakeNote's "skip if entity already has
 * notes" guard). Failures are returned as a per-entity report but never
 * fail the parent intake — the client treats this call as fire-and-forget.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { autoPostIntakeNote } from '@/lib/intake-note-autopost';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const sb = createServerRouteClient(cookieStore);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    let body: { request_id?: string; notes?: string };
    try { body = await request.json(); }
    catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

    const requestId = body.request_id?.trim();
    if (!requestId) return NextResponse.json({ error: 'request_id required' }, { status: 400 });

    const { data: profile } = await sb.from('profiles')
      .select('role, client_id, full_name, email')
      .eq('id', user.id).single() as { data: { role: string; client_id: string | null; full_name: string | null; email: string } | null };
    if (!profile || !profile.client_id) {
      return NextResponse.json({ error: 'No client profile' }, { status: 403 });
    }

    const admin = createAdminClient();

    // Verify the request actually belongs to this user's client.
    // Prevents a caller from posting intake notes onto somebody else's
    // entities via guessed request IDs.
    const { data: reqRow } = await admin.from('requests')
      .select('id, client_id, requested_by, notes')
      .eq('id', requestId).single() as { data: { id: string; client_id: string; requested_by: string; notes: string | null } | null };
    if (!reqRow) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

    const isPrivileged = profile.role === 'admin';
    const ownsRequest = reqRow.client_id === profile.client_id;
    if (!isPrivileged && !ownsRequest) {
      return NextResponse.json({ error: 'Request does not belong to your client' }, { status: 403 });
    }

    const { data: entities } = await admin.from('request_entities')
      .select('id, entity_name, form_type, years')
      .eq('request_id', requestId) as { data: any[] | null };
    if (!entities || entities.length === 0) {
      return NextResponse.json({ posted: 0, skipped: 0, results: [] });
    }

    const requesterRole = (['admin', 'expert', 'processor', 'manager'] as const)
      .includes((profile.role as any)) ? (profile.role as any) : 'processor';
    const requesterName = profile.full_name || profile.email || 'Processor';
    // Prefer the explicit notes from the client request; fall back to the
    // request row's notes (manual flow stores the free-text on the request).
    const freeTextNotes = (body.notes && body.notes.trim()) ? body.notes : (reqRow.notes || null);

    const settled = await Promise.allSettled(entities.map((e: any) =>
      autoPostIntakeNote(admin, {
        entityId: e.id,
        entityName: e.entity_name,
        formType: e.form_type,
        years: e.years,
        requesterUserId: user.id,
        requesterName,
        requesterRole,
        clientId: reqRow.client_id,
        freeTextNotes,
      }),
    ));

    let posted = 0;
    let skipped = 0;
    const results: Array<{ entity_id: string; posted: boolean; reason?: string }> = [];
    settled.forEach((s, i) => {
      const entityId = entities[i].id;
      if (s.status === 'fulfilled') {
        if (s.value.posted) posted++; else skipped++;
        results.push({ entity_id: entityId, posted: s.value.posted, reason: s.value.reason });
      } else {
        skipped++;
        results.push({ entity_id: entityId, posted: false, reason: (s.reason as any)?.message || String(s.reason) });
      }
    });

    return NextResponse.json({ posted, skipped, results });
  } catch (err: any) {
    console.error('[post-intake-notes]', err);
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 });
  }
}
