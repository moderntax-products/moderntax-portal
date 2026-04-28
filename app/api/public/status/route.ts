/**
 * GET /api/public/status — Public IRS call metrics for the status page.
 *
 * No auth. Slim payload — just what the customer needs to answer
 * "is the IRS slow right now and how long should I expect to wait?".
 *
 * Cached 15s at the edge so a public refresh storm doesn't hammer the
 * DB while still feeling real-time on the page (which polls every 15s).
 *
 * Returns:
 * {
 *   updated_at: ISO,
 *   current_wait_minutes: number | null,    // live: how long current
 *                                            //  on-hold callers have
 *                                            //  been waiting (max),
 *                                            //  null if nobody on hold
 *   lifetime_avg_hold_minutes: number | null, // every completed call
 *                                              //  ever, hold duration avg
 *   lifetime_calls_completed: int,           // counter for context
 *   last_call: { ended_at, hold_minutes, duration_minutes, status, entities } | null
 * }
 */

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';

export const revalidate = 15;

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

export async function GET() {
  try {
    const admin = createAdminClient();

    // ───────── CURRENT WAIT (real-time) ─────────
    // Anyone currently on hold with the IRS — how long have they been
    // waiting so far? Reported as the longest current wait (worst case),
    // since that's the more honest "if you call now, this is what you'd
    // experience" number than an average that gets diluted by sessions
    // that JUST hit hold.
    const { data: holdSessions } = await (admin.from('irs_call_sessions' as any) as any)
      .select('id, status, initiated_at, connected_at')
      .eq('status', 'on_hold');

    const now = Date.now();
    const currentWaitMins: number | null = (holdSessions || []).length === 0
      ? null
      : Math.max(
          ...(holdSessions || []).map((s: any) => {
            // Prefer connected_at (when we actually got into the hold queue);
            // fall back to initiated_at for sessions that don't track it.
            const start = s.connected_at || s.initiated_at;
            if (!start) return 0;
            return (now - new Date(start).getTime()) / 60_000;
          }),
        );

    // ───────── LIFETIME AVG HOLD ─────────
    // Every completed call's hold_duration_seconds, averaged. Trims at
    // 5000 to keep the query bounded as we scale; we'll switch to a
    // pre-aggregated view once volume warrants.
    const { data: completedSessions } = await (admin.from('irs_call_sessions' as any) as any)
      .select('id, hold_duration_seconds')
      .eq('status', 'completed')
      .not('hold_duration_seconds', 'is', null)
      .order('ended_at', { ascending: false })
      .limit(5000);

    const holdMins = (completedSessions || [])
      .map((s: any) => (s.hold_duration_seconds || 0) / 60)
      .filter((m: number) => m > 0);
    const lifetimeAvgHold = avg(holdMins);

    // ───────── LAST CALL ─────────
    const { data: lastSessionRow } = await (admin.from('irs_call_sessions' as any) as any)
      .select('id, status, ended_at, duration_seconds, hold_duration_seconds, irs_call_entities(id)')
      .in('status', ['completed', 'failed'])
      .not('ended_at', 'is', null)
      .order('ended_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const lastCall = lastSessionRow
      ? {
          ended_at: lastSessionRow.ended_at,
          hold_minutes: lastSessionRow.hold_duration_seconds
            ? Math.round((lastSessionRow.hold_duration_seconds / 60) * 10) / 10
            : null,
          duration_minutes: lastSessionRow.duration_seconds
            ? Math.round((lastSessionRow.duration_seconds / 60) * 10) / 10
            : null,
          status: lastSessionRow.status,
          entities: lastSessionRow.irs_call_entities?.length || 0,
        }
      : null;

    // ───────── LIFETIME COUNT (for the "based on N calls" context) ─────────
    const { count: lifetimeCallsCompleted } = await (admin
      .from('irs_call_sessions' as any) as any)
      .select('id', { count: 'exact', head: true })
      .eq('status', 'completed');

    return NextResponse.json(
      {
        updated_at: new Date().toISOString(),
        current_wait_minutes: currentWaitMins === null ? null : Math.round(currentWaitMins * 10) / 10,
        lifetime_avg_hold_minutes: lifetimeAvgHold === null ? null : Math.round(lifetimeAvgHold * 10) / 10,
        lifetime_calls_completed: lifetimeCallsCompleted || 0,
        last_call: lastCall,
      },
      {
        headers: {
          // 15s edge cache + 60s stale-while-revalidate. Keeps the page
          // feeling live while shielding the DB from refresh storms.
          'Cache-Control': 's-maxage=15, stale-while-revalidate=60',
        },
      },
    );
  } catch (err) {
    console.error('[/api/public/status] error:', err);
    return NextResponse.json({ error: 'Status temporarily unavailable' }, { status: 503 });
  }
}
