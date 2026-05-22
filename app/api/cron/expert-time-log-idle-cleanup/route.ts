/**
 * GET /api/cron/expert-time-log-idle-cleanup
 *
 * Closes auto-instrumented time-log sessions that haven't received an
 * activity ping in IDLE_THRESHOLD_MINUTES. Without this, a sor_upload
 * session opened by one bookmarklet run stays "open" forever (the cron
 * compensates the expert for hours they aren't working).
 *
 * Rules:
 *  • sor_upload + manual + irs_direct_dial sessions idle >15 min → close
 *  • bland_call / retell_call sessions are closed by the webhook on
 *    call-completed; this cron catches webhook misses (idle >2 hr)
 *  • Hard cap: ANY session open >4 hr gets closed regardless of kind
 *
 * Scheduled every 15 min in vercel.json. Idempotent.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const IDLE_BY_KIND: Record<string, number> = {
  sor_upload: 15,
  manual: 15,
  irs_direct_dial: 15,
  bland_call: 120,    // webhook normally closes these
  retell_call: 120,   // webhook normally closes these
};
const HARD_CAP_HOURS = 4;

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const sb = createAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();

  const { data: open, error } = await sb.from('expert_time_logs')
    .select('id, expert_id, source, start_at, notes')
    .is('end_at', null) as { data: any[] | null; error: any };
  if (error) return NextResponse.json({ error: 'Query failed', detail: error.message }, { status: 500 });

  let closedCount = 0;
  const closures: { id: string; kind: string; hours: number; reason: string }[] = [];

  for (const s of open || []) {
    const startMs = new Date(s.start_at).getTime();
    // Until the migration adds last_activity_at, idle is measured from start.
    // That's conservative — overestimates idleness — which favors closing
    // forgotten sessions rather than leaving them open.
    const idleMinutes = (now.getTime() - startMs) / 1000 / 60;
    const totalHours = (now.getTime() - startMs) / 1000 / 3600;
    const kind = s.source || 'manual';
    const idleThreshold = IDLE_BY_KIND[kind] ?? 15;

    let reason: string | null = null;
    if (totalHours >= HARD_CAP_HOURS) reason = 'session_max_duration';
    else if (idleMinutes >= idleThreshold) reason = 'idle_timeout';
    if (!reason) continue;

    // For hard-cap closures, the effective end is start + HARD_CAP_HOURS,
    // NOT now — otherwise a session that was orphaned 6 hours ago records
    // the full 6 hours as billable (Matt's iCloud-expert orphan on 2026-05-22
    // logged 6.02h when it should have capped at 4.00h, blowing daily COGS).
    //
    // For idle-timeout closures, the effective end is start + idle threshold
    // (in minutes — same logic). The reasoning: we don't know what happened
    // between the threshold and now, but the threshold is the latest moment
    // we have any evidence of activity, so it's the most defensible bound.
    let effectiveEndMs: number;
    if (reason === 'session_max_duration') {
      effectiveEndMs = startMs + HARD_CAP_HOURS * 3600 * 1000;
    } else {
      effectiveEndMs = startMs + idleThreshold * 60 * 1000;
    }
    const hours = Math.round(((effectiveEndMs - startMs) / 1000 / 3600) * 100) / 100;
    const auditNote = `[auto-closed by idle-cleanup ${nowIso} reason=${reason} capped_to=${hours}h]`;
    await (sb.from('expert_time_logs') as any).update({
      end_at: new Date(effectiveEndMs).toISOString(),
      hours_worked: hours,
      notes: s.notes ? `${auditNote} | ${s.notes}` : auditNote,
    }).eq('id', s.id);
    closedCount++;
    closures.push({ id: s.id, kind, hours, reason });
  }

  return NextResponse.json({
    success: true,
    closed_count: closedCount,
    closures,
    processed_at: nowIso,
  });
}
