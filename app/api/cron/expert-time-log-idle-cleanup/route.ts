/**
 * GET /api/cron/expert-time-log-idle-cleanup
 *
 * Closes auto-instrumented time-log sessions that haven't received an
 * activity ping in IDLE_THRESHOLD_MINUTES. Without this, a sor_upload
 * session opened by one bookmarklet run stays "open" forever (the cron
 * compensates the expert for hours they aren't working).
 *
 * Rules:
 *  • Idle is measured from `updated_at` (the last activity ping), NOT from
 *    start_at. The event route + the dashboard widget refresh updated_at on
 *    every start/extend/heartbeat, so an actively-worked session stays open.
 *    (Before this fix idle was measured from start_at, so EVERY session was
 *    force-closed 15 min after it began — even while the expert was on a
 *    30–90 min IRS PPS hold. That shredded real worked time. — Joel A. 6/04.)
 *  • sor_upload idle >15 min (since last upload) → close
 *  • manual / irs_direct_dial are EXPLICIT clock-ins and are NOT idle-closed on
 *    the ordinary short timers. The expert punches out by hand (authoritative).
 *    An expert on a long IRS PPS hold makes no clicks and may background the
 *    tab, so a short inactivity timeout shreds real worked time — the exact bug
 *    Joel hit repeatedly.
 *  • PHANTOM GUARD (manual / irs_direct_dial): if such a session is idle for
 *    >PHANTOM_IDLE_MINUTES (3 hr — well past the longest real PPS hold) AND has
 *    ZERO production (0 tins_completed AND 0 attributed entities), it's a timer
 *    left running on an abandoned tab, not real work. Close it at the last
 *    activity bound (≈0 billable hours). Real work produces an entity/TIN or a
 *    heartbeat within 3 hr, so this can't shred a genuine hold. This is the
 *    hole that let Matt's iCloud-expert phantom bill the full 6-hr HARD_CAP on
 *    2026-07-09 and fake a −89% daily margin.
 *  • bland_call / retell_call sessions are closed by the webhook on
 *    call-completed; this cron catches webhook misses (idle >2 hr)
 *  • Hard cap: ANY session open >6 hr gets closed (forgotten clock-out only)
 *
 * Scheduled every 15 min in vercel.json. Idempotent.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Idle-close thresholds (minutes) — ONLY for auto-instrumented kinds. Explicit
// clock-ins (manual / irs_direct_dial) are intentionally absent: they are NEVER
// idle-closed (see NEVER_IDLE_CLOSE below).
const IDLE_BY_KIND: Record<string, number> = {
  sor_upload: 15,        // fire-and-forget; 15 min since last upload ping
  bland_call: 120,       // webhook normally closes these
  retell_call: 120,      // webhook normally closes these
};

// Explicit clock-ins the expert starts/stops by hand. These are NEVER closed by
// inactivity — an expert on a 30–90 min IRS PPS hold makes no clicks and may
// have the tab backgrounded (so even the dashboard heartbeat can't fire). The
// only auto-close for these is the HARD_CAP backstop for a forgotten clock-out.
// (Joel A. was repeatedly clocked out mid-call at 15 min — 6/04 & 6/05.)
const NEVER_IDLE_CLOSE = new Set(['manual', 'irs_direct_dial']);

// Phantom guard for the explicit clock-ins above: a session idle THIS long with
// zero production is a forgotten/abandoned timer, not a hold. 3 hr sits well
// past the longest real IRS PPS hold (~90 min) so it can't clip live work.
const PHANTOM_IDLE_MINUTES = 180;

const HARD_CAP_HOURS = 6;

// True when a session shows no sign of real work: no verified units and no
// entity attributed in notes (format "entities=[id1,id2]"). Used only to
// justify closing an otherwise-never-idle-closed manual/PPS session.
function hasZeroProduction(tinsCompleted: number, notes: string | null | undefined): boolean {
  if ((Number(tinsCompleted) || 0) > 0) return false;
  const m = (notes || '').match(/entities=\[([^\]]*)\]/);
  const entityIds = (m?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return entityIds.length === 0;
}

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const sb = createAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();

  const { data: open, error } = await sb.from('expert_time_logs')
    .select('id, expert_id, source, start_at, updated_at, notes, tins_completed')
    .is('end_at', null) as { data: any[] | null; error: any };
  if (error) return NextResponse.json({ error: 'Query failed', detail: error.message }, { status: 500 });

  let closedCount = 0;
  const closures: { id: string; kind: string; hours: number; reason: string }[] = [];

  for (const s of open || []) {
    const startMs = new Date(s.start_at).getTime();
    // Last activity = updated_at (bumped on every start/extend/heartbeat in the
    // event route). Fall back to start_at if updated_at is somehow null/older.
    const lastActivityMs = Math.max(startMs, s.updated_at ? new Date(s.updated_at).getTime() : startMs);
    const idleMinutes = (now.getTime() - lastActivityMs) / 1000 / 60;
    const totalHours = (now.getTime() - startMs) / 1000 / 3600;
    const kind = s.source || 'manual';

    let reason: string | null = null;
    if (totalHours >= HARD_CAP_HOURS) {
      // Hard cap applies to every kind, incl. a forgotten manual clock-out.
      reason = 'session_max_duration';
    } else if (!NEVER_IDLE_CLOSE.has(kind)) {
      const idleThreshold = IDLE_BY_KIND[kind] ?? 15;
      if (idleMinutes >= idleThreshold) reason = 'idle_timeout';
    } else if (
      // Phantom guard for explicit clock-ins: long idle + zero production only.
      idleMinutes >= PHANTOM_IDLE_MINUTES &&
      hasZeroProduction(s.tins_completed, s.notes)
    ) {
      reason = 'phantom_no_activity';
    }
    if (!reason) continue;

    // For hard-cap closures, the effective end is start + HARD_CAP_HOURS,
    // NOT now — otherwise a session that was orphaned 6 hours ago records
    // the full 6 hours as billable (Matt's iCloud-expert orphan on 2026-05-22
    // logged 6.02h when it should have capped at 4.00h, blowing daily COGS).
    //
    // For idle-timeout closures, the effective end is the LAST ACTIVITY
    // timestamp (updated_at): that's the latest moment we have real evidence
    // the expert was working, so it's the most defensible billable bound.
    let effectiveEndMs: number;
    if (reason === 'session_max_duration') {
      effectiveEndMs = startMs + HARD_CAP_HOURS * 3600 * 1000;
    } else {
      effectiveEndMs = lastActivityMs;
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
