/**
 * GET /api/cron/extract-pps-signals-backfill
 *
 * Every 15 min. Scans irs_call_sessions for rows where:
 *   - ended_at IS NOT NULL (call is over)
 *   - classified_outcome IS NULL (signals never extracted)
 *   - concatenated_transcript IS NOT NULL (something to extract from)
 *
 * Runs extractPpsSignals() against the transcript and persists
 * classified_outcome, coaching_tags, irs_agent_name, irs_agent_badge,
 * hold_duration_seconds, call_summary. Also flips callback_status from
 * 'waiting' to 'accepted' when the transcript shows IRS confirming.
 *
 * Why this exists: the 2026-05-23 audit found
 *   - Bland: 91.5% transcript coverage, 0.0% coaching_tags coverage
 *   - Retell: 18% classified_outcome, 0% irs_agent_name
 * The root cause is a race between the provider webhook (which does
 * extraction) and the /api/expert/irs-call/status poll endpoint (which
 * fetches live transcript but doesn't extract). When the poll wins,
 * raw data is stored without any post-call analysis.
 *
 * This backfill catches both the historical gap and any future
 * webhook-missed calls. Idempotent — skips rows that already have
 * classified_outcome set.
 *
 * Auth: CRON_SECRET only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { extractPpsSignals } from '@/lib/irs-pps-signal-extractor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();

  // Pull up to 200 unprocessed sessions per run. With a 15-min schedule
  // that's 800/hour of throughput — far more than our call volume.
  const { data: sessions, error } = await admin
    .from('irs_call_sessions' as any)
    .select('id, bland_call_id, callback_status, callback_mode, status, ended_at, duration_seconds, concatenated_transcript, error_message')
    .not('ended_at', 'is', null)
    .is('classified_outcome', null)
    .not('concatenated_transcript', 'is', null)
    .order('ended_at', { ascending: false })
    .limit(200) as { data: any[]; error: any };

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results = { scanned: sessions?.length || 0, classified: 0, callback_flipped: 0, skipped: 0 };
  const outcomeDist: Record<string, number> = {};

  for (const s of (sessions || [])) {
    const transcript: string = s.concatenated_transcript || '';
    if (transcript.length < 20) { results.skipped++; continue; }
    const durationMs = (s.duration_seconds || 0) * 1000;
    const signals = extractPpsSignals(transcript, durationMs, s.error_message || null);

    const classifiedOutcome =
      signals.agentAnswered ? 'agent_answered'
      : signals.callbackOffered && s.callback_mode === 'irs_callback' ? 'callback_offered'
      : signals.callbackOffered ? 'callback_offered_but_not_taken'
      : signals.overflowRejected ? 'overflow_rejected'
      : signals.announcedWaitMinutes && signals.announcedWaitMinutes > 15 ? 'wait_too_long_no_callback'
      : 'short_call_no_signal';

    const coachingTags = [
      signals.announcedWaitMinutes !== null ? `wait_${signals.announcedWaitMinutes}min` : null,
      signals.callbackOffered ? 'callback_offered' : 'no_callback_offered',
      signals.overflowRejected ? 'overflow_rejected' : null,
      signals.agentAnswered ? 'agent_answered' : null,
    ].filter(Boolean) as string[];

    const acceptedCallback =
      signals.callbackOffered &&
      s.callback_mode === 'irs_callback' &&
      /\b(?:yes|sure|okay|will call|confirmed|noted|on (?:our|the) list)\b/i.test(transcript);

    const patch: Record<string, any> = {
      classified_outcome: classifiedOutcome,
      call_summary: signals.summary,
      coaching_tags: coachingTags,
      irs_agent_name: signals.agentName,
      irs_agent_badge: signals.agentBadge,
      hold_duration_seconds: signals.holdSeconds,
    };
    if (acceptedCallback && s.callback_status === 'waiting') {
      patch.callback_status = 'accepted';
      patch.callback_initiated_at = new Date().toISOString();
      results.callback_flipped++;
    }

    const { error: updErr } = await (admin.from('irs_call_sessions' as any) as any)
      .update(patch).eq('id', s.id);
    if (updErr) {
      console.warn(`[extract-pps-backfill] update failed for ${s.id}: ${updErr.message}`);
      results.skipped++;
      continue;
    }
    results.classified++;
    outcomeDist[classifiedOutcome] = (outcomeDist[classifiedOutcome] || 0) + 1;
  }

  console.log(
    `[extract-pps-backfill] scanned=${results.scanned} classified=${results.classified} ` +
    `callback_flipped=${results.callback_flipped} skipped=${results.skipped} ` +
    `dist=${JSON.stringify(outcomeDist)}`,
  );

  return NextResponse.json({ ...results, outcome_distribution: outcomeDist });
}
