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
    .select('id, expert_id, kind, start_at, last_activity_at, attributed_entity_ids')
    .is('end_at', null) as { data: any[] | null; error: any };
  if (error) return NextResponse.json({ error: 'Query failed', detail: error.message }, { status: 500 });

  let closedCount = 0;
  const closures: { id: string; kind: string; hours: number; reason: string }[] = [];

  for (const s of open || []) {
    const startMs = new Date(s.start_at).getTime();
    const lastActivityMs = s.last_activity_at ? new Date(s.last_activity_at).getTime() : startMs;
    const idleMinutes = (now.getTime() - lastActivityMs) / 1000 / 60;
    const totalHours = (now.getTime() - startMs) / 1000 / 3600;
    const idleThreshold = IDLE_BY_KIND[s.kind] ?? 15;

    let reason: string | null = null;
    if (totalHours >= HARD_CAP_HOURS) reason = 'session_max_duration';
    else if (idleMinutes >= idleThreshold) reason = 'idle_timeout';
    if (!reason) continue;

    // Close it. hours_worked from start → last_activity_at (not now), so
    // an idle session doesn't get credit for the idle gap.
    const effectiveEndMs = reason === 'idle_timeout' ? lastActivityMs : now.getTime();
    const hours = Math.round(((effectiveEndMs - startMs) / 1000 / 3600) * 100) / 100;
    await (sb.from('expert_time_logs') as any).update({
      end_at: new Date(effectiveEndMs).toISOString(),
      hours_worked: hours,
      auto_closed_reason: reason,
    }).eq('id', s.id);
    closedCount++;
    closures.push({ id: s.id, kind: s.kind, hours, reason });
  }

  return NextResponse.json({
    success: true,
    closed_count: closedCount,
    closures,
    processed_at: nowIso,
  });
}
