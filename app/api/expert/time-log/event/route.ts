/**
 * POST /api/expert/time-log/event
 *
 * Single endpoint for all expert time-tracking events. Idempotent + rolling:
 * call it on activity-start, activity-progress, and activity-stop. The
 * server figures out whether to open a new session row, extend the existing
 * open session, or close it.
 *
 * Body:
 *   {
 *     action: 'start' | 'extend' | 'stop',
 *     kind: 'manual' | 'bland_call' | 'retell_call' | 'sor_upload' | 'irs_direct_dial',
 *     entity_id?: string,            // optional — appends to attributed_entity_ids[]
 *     source_session_id?: string,    // bland_call_id / irs_call_sessions.id / upload run UUID
 *     notes?: string,                // freeform
 *   }
 *
 * Semantics (per kind):
 *  • bland_call / retell_call — auto-fired by webhook on call connect /
 *    callback accepted. action=start opens a row; subsequent extend events
 *    just refresh last_activity_at; action=stop closes the row.
 *  • sor_upload — auto-fired by batch-upload on every transcript upload.
 *    The first upload opens a session (kind=sor_upload). Each subsequent
 *    upload within ROLLING_EXTEND_MIN minutes extends last_activity_at.
 *    The idle-close cron closes sessions that haven't been pinged in
 *    that window.
 *  • manual / irs_direct_dial — fired by the "I'm calling IRS now" button
 *    on the expert dashboard. action=start opens; action=stop closes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Kind = 'manual' | 'bland_call' | 'retell_call' | 'sor_upload' | 'irs_direct_dial';

interface Body {
  action: 'start' | 'extend' | 'stop';
  kind: Kind;
  entity_id?: string;
  source_session_id?: string;
  notes?: string;
  // Internal use only: server-side callers (Bland webhook, batch-upload)
  // pass the expert_id directly since they don't have a user session.
  // Public callers (the /expert dashboard button) come in with an auth
  // cookie and we derive expert_id from that.
  _expert_id_override?: string;
  _server_secret?: string;
}

const SERVER_SHARED_SECRET = process.env.EXPERT_TIME_LOG_SHARED_SECRET || ''; // optional; if unset, no override allowed

export async function POST(request: NextRequest) {
  let body: Body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { action, kind, entity_id, source_session_id, notes, _expert_id_override, _server_secret } = body;
  if (!['start', 'extend', 'stop'].includes(action)) {
    return NextResponse.json({ error: 'action must be start/extend/stop' }, { status: 400 });
  }
  if (!['manual', 'bland_call', 'retell_call', 'sor_upload', 'irs_direct_dial'].includes(kind)) {
    return NextResponse.json({ error: 'invalid kind' }, { status: 400 });
  }

  // Resolve expert_id — server-side override or user session
  let expertId: string | null = null;
  if (_expert_id_override && _server_secret && SERVER_SHARED_SECRET && _server_secret === SERVER_SHARED_SECRET) {
    expertId = _expert_id_override;
  } else {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
    if (!profile || profile.role !== 'expert') {
      return NextResponse.json({ error: 'Expert role required' }, { status: 403 });
    }
    expertId = user.id;
  }

  const admin = createAdminClient();

  // Find this expert's currently-open session of the same kind (if any).
  // We allow one open session PER (expert, kind) — so an expert can have
  // simultaneous "on Bland call" + "running SOR script" sessions if they
  // really do both at once, but not two of the same kind.
  const { data: openSessions } = await admin.from('expert_time_logs')
    .select('id, start_at, last_activity_at, attributed_entity_ids, source_session_id, notes')
    .eq('expert_id', expertId)
    .eq('kind', kind)
    .is('end_at', null)
    .order('start_at', { ascending: false })
    .limit(1) as { data: any[] | null };
  const openSession = openSessions?.[0] || null;

  const now = new Date().toISOString();

  if (action === 'start') {
    if (openSession) {
      // Already open — treat as extend (idempotent)
      const newEntityList = mergeEntities(openSession.attributed_entity_ids, entity_id);
      await (admin.from('expert_time_logs') as any).update({
        last_activity_at: now,
        attributed_entity_ids: newEntityList,
      }).eq('id', openSession.id);
      return NextResponse.json({ session_id: openSession.id, action: 'extended (was already open)' });
    }
    const { data: created, error: insErr } = await (admin.from('expert_time_logs') as any).insert({
      expert_id: expertId,
      start_at: now,
      end_at: null,
      break_minutes: 0,
      hours_worked: 0,
      tins_completed: 0,
      kind,
      attributed_entity_ids: entity_id ? [entity_id] : [],
      source_session_id: source_session_id || null,
      last_activity_at: now,
      notes: notes || null,
    } as any).select('id').single() as { data: any; error: any };
    if (insErr) return NextResponse.json({ error: 'Insert failed', detail: insErr.message }, { status: 500 });
    return NextResponse.json({ session_id: created.id, action: 'started' });
  }

  if (action === 'extend') {
    if (!openSession) {
      // No open session — treat as start (idempotent: first event ever auto-opens)
      const { data: created, error: insErr } = await (admin.from('expert_time_logs') as any).insert({
        expert_id: expertId,
        start_at: now,
        end_at: null,
        break_minutes: 0,
        hours_worked: 0,
        tins_completed: 0,
        kind,
        attributed_entity_ids: entity_id ? [entity_id] : [],
        source_session_id: source_session_id || null,
        last_activity_at: now,
        notes: notes || null,
      } as any).select('id').single() as { data: any; error: any };
      if (insErr) return NextResponse.json({ error: 'Insert failed', detail: insErr.message }, { status: 500 });
      return NextResponse.json({ session_id: created.id, action: 'auto-started (first event)' });
    }
    const newEntityList = mergeEntities(openSession.attributed_entity_ids, entity_id);
    await (admin.from('expert_time_logs') as any).update({
      last_activity_at: now,
      attributed_entity_ids: newEntityList,
    }).eq('id', openSession.id);
    return NextResponse.json({ session_id: openSession.id, action: 'extended' });
  }

  // action === 'stop'
  if (!openSession) {
    return NextResponse.json({ session_id: null, action: 'no-op (no open session)' });
  }
  const startMs = new Date(openSession.start_at).getTime();
  const endMs = Date.now();
  const hours = Math.round(((endMs - startMs) / 1000 / 3600) * 100) / 100;
  await (admin.from('expert_time_logs') as any).update({
    end_at: now,
    hours_worked: hours,
    auto_closed_reason: 'explicit_stop',
  }).eq('id', openSession.id);
  return NextResponse.json({ session_id: openSession.id, action: 'stopped', hours_worked: hours });
}

function mergeEntities(existing: string[] | null | undefined, add: string | undefined): string[] {
  const list = new Set<string>(existing || []);
  if (add) list.add(add);
  return [...list];
}
