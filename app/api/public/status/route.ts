/**
 * GET /api/public/status — Public IRS call metrics for the status page.
 *
 * No auth. Caller-friendly aggregates only — no PII, no per-customer
 * detail. Cached at the edge (s-maxage=60) so a customer refresh storm
 * doesn't hammer the DB.
 *
 * Returns:
 * {
 *   updated_at: ISO,
 *   live: {
 *     active_calls: int,                  // calls currently in flight
 *     calls_on_hold: int,                 // subset on IVR hold w/ IRS
 *     experts_active: int,                // distinct experts with running call
 *   },
 *   wait_times: {
 *     avg_hold_minutes_today: number | null,
 *     avg_hold_minutes_7d: number | null,
 *     median_hold_minutes_7d: number | null,
 *   },
 *   throughput: {
 *     entities_completed_today: int,
 *     entities_completed_7d: int,
 *     calls_completed_today: int,
 *     calls_completed_7d: int,
 *     success_rate_7d: number,            // 0..1, completed / (completed + failed)
 *   },
 *   recent: Array<{ ended_at, duration_minutes, hold_minutes, status, entities }>
 * }
 */

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';

export const revalidate = 60;

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

export async function GET() {
  try {
    const admin = createAdminClient();
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();

    // ───────── LIVE ─────────
    const { data: liveSessions } = await (admin.from('irs_call_sessions' as any) as any)
      .select('id, status, expert_id')
      .in('status', ['initiating', 'ringing', 'navigating_ivr', 'on_hold', 'speaking_to_agent']);

    const activeCalls = liveSessions?.length || 0;
    const callsOnHold = (liveSessions || []).filter((s: any) => s.status === 'on_hold').length;
    const expertsActive = new Set((liveSessions || []).map((s: any) => s.expert_id)).size;

    // ───────── WAIT TIMES (today + 7d) ─────────
    const { data: completedSessions } = await (admin.from('irs_call_sessions' as any) as any)
      .select('id, status, ended_at, duration_seconds, hold_duration_seconds, initiated_at')
      .eq('status', 'completed')
      .gte('ended_at', sevenDaysAgo);

    const todayCompleted = (completedSessions || []).filter((s: any) => s.ended_at >= todayStart);
    const todayHoldMins = todayCompleted
      .map((s: any) => (s.hold_duration_seconds || 0) / 60)
      .filter((m: number) => m > 0);
    const sevenDayHoldMins = (completedSessions || [])
      .map((s: any) => (s.hold_duration_seconds || 0) / 60)
      .filter((m: number) => m > 0);

    // ───────── THROUGHPUT ─────────
    const { count: entitiesCompletedTodayCount } = await (admin
      .from('irs_call_entities' as any) as any)
      .select('id', { count: 'exact', head: true })
      .in('outcome', ['transcripts_requested', 'transcripts_verbal', 'fax_sent'])
      .gte('updated_at', todayStart);

    const { count: entitiesCompleted7dCount } = await (admin
      .from('irs_call_entities' as any) as any)
      .select('id', { count: 'exact', head: true })
      .in('outcome', ['transcripts_requested', 'transcripts_verbal', 'fax_sent'])
      .gte('updated_at', sevenDaysAgo);

    const callsCompletedToday = todayCompleted.length;
    const callsCompleted7d = (completedSessions || []).length;
    const { count: callsFailed7d } = await (admin
      .from('irs_call_sessions' as any) as any)
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed')
      .gte('ended_at', sevenDaysAgo);

    const totalCallsClosed = callsCompleted7d + (callsFailed7d || 0);
    const successRate7d = totalCallsClosed > 0 ? callsCompleted7d / totalCallsClosed : 1;

    // ───────── RECENT (last 10 closed sessions, no PII) ─────────
    const { data: recentSessions } = await (admin.from('irs_call_sessions' as any) as any)
      .select('id, status, ended_at, duration_seconds, hold_duration_seconds, irs_call_entities(id)')
      .in('status', ['completed', 'failed'])
      .not('ended_at', 'is', null)
      .order('ended_at', { ascending: false })
      .limit(10);

    const recent = (recentSessions || []).map((s: any) => ({
      ended_at: s.ended_at,
      duration_minutes: s.duration_seconds ? Math.round((s.duration_seconds / 60) * 10) / 10 : null,
      hold_minutes: s.hold_duration_seconds ? Math.round((s.hold_duration_seconds / 60) * 10) / 10 : null,
      status: s.status,
      entities: s.irs_call_entities?.length || 0,
    }));

    return NextResponse.json(
      {
        updated_at: new Date().toISOString(),
        live: {
          active_calls: activeCalls,
          calls_on_hold: callsOnHold,
          experts_active: expertsActive,
        },
        wait_times: {
          avg_hold_minutes_today: avg(todayHoldMins),
          avg_hold_minutes_7d: avg(sevenDayHoldMins),
          median_hold_minutes_7d: median(sevenDayHoldMins),
        },
        throughput: {
          entities_completed_today: entitiesCompletedTodayCount || 0,
          entities_completed_7d: entitiesCompleted7dCount || 0,
          calls_completed_today: callsCompletedToday,
          calls_completed_7d: callsCompleted7d,
          success_rate_7d: Math.round(successRate7d * 1000) / 1000,
        },
        recent,
      },
      {
        headers: {
          // 60s edge cache + 5min stale-while-revalidate so a refresh storm
          // hits the CDN, not the DB. Acceptable freshness for a status page.
          'Cache-Control': 's-maxage=60, stale-while-revalidate=300',
        },
      },
    );
  } catch (err) {
    console.error('[/api/public/status] error:', err);
    return NextResponse.json({ error: 'Status temporarily unavailable' }, { status: 503 });
  }
}
