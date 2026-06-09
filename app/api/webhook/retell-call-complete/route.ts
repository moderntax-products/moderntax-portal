/**
 * Retell post-call webhook
 *
 * POST — Fires when Retell finishes a call. The two events we care about:
 *   - call_ended    → raw call data + transcript
 *   - call_analyzed → post-call LLM analysis (Retell's GPT-4.1 layer)
 *
 * Why this exists: the 60-day audit (2026-05-23) found that 82% of
 * irs_call_sessions rows had `classified_outcome = NULL` because the
 * post-call signal-extraction step was never wired up for Retell — it only
 * ran inside the standalone `scripts/autodial-irs-callback.ts` polling
 * loop, never on production webhook completions. As a result we could not
 * measure callback-success-rate (tier 1), transfer-to-human rate (tier 2),
 * or end-to-end completion (tier 3). All three came back as 0% in the
 * audit, but the real number is unmeasurable without this hook.
 *
 * Wiring (Retell side):
 *   Set the webhook URL on each Retell agent (or globally) to
 *   https://portal.moderntax.io/api/webhook/retell-call-complete
 *   with the auth header `x-retell-secret: $RETELL_WEBHOOK_SECRET`.
 *   Configure via Retell dashboard → Agent settings → Webhook URL.
 *
 * Behavior:
 *   1. Find the session by bland_call_id (Retell IDs live in this column —
 *      legacy naming from before the Bland→Retell switch).
 *   2. Run extractPpsSignals() on the transcript.
 *   3. Persist classified_outcome, irs_agent_name, irs_agent_badge,
 *      hold_duration_seconds, coaching_tags, call_summary.
 *   4. Update callback_status if signals indicate offer/accept/decline.
 *   5. Return 200 fast (Retell retries on 5xx).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { extractPpsSignals } from '@/lib/irs-pps-signal-extractor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  // Retell webhooks don't support arbitrary auth headers in the dashboard
  // (their signature scheme is HMAC-SHA256 in x-retell-signature, which we
  // could implement later). For now we validate a URL-embedded secret —
  // the agent's webhook_url is configured as
  // https://portal.moderntax.io/api/webhook/retell-call-complete?secret=XXX
  // and we compare ?secret= against RETELL_WEBHOOK_SECRET. Same trust
  // model as a fixed bearer token; just transport in URL vs header.
  const expected = process.env.RETELL_WEBHOOK_SECRET;
  const provided = request.nextUrl.searchParams.get('secret');
  if (!expected || provided !== expected) {
    console.error('[retell-webhook] unauthorized (missing/invalid ?secret=)');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }

  const event = body.event || body.type || 'unknown';
  const call = body.call || body.data || body;
  const callId = call.call_id;

  // We act on call_ended (we have transcript at this point) and call_analyzed
  // (Retell has added structured fields). We skip call_started and ignore
  // anything else.
  if (event !== 'call_ended' && event !== 'call_analyzed') {
    return NextResponse.json({ received: true, skipped: event });
  }
  if (!callId) {
    return NextResponse.json({ error: 'missing call_id' }, { status: 400 });
  }

  const admin = createAdminClient();

  // Find session — Retell IDs are stored in the bland_call_id column (legacy
  // naming; column was named before the Retell migration). Inbound callback
  // resume calls have a fresh call_id that won't match the original outbound
  // session, so fall back to metadata.session_id (set by the inbound webhook).
  const metaSessionId: string | undefined = call.metadata?.session_id || body.metadata?.session_id;
  const isCallbackResume = (call.metadata?.mode || body.metadata?.mode) === 'callback_resume';
  let { data: session } = await admin.from('irs_call_sessions' as any)
    .select('id, status, callback_status, callback_mode, classified_outcome')
    .eq('bland_call_id', callId)
    .maybeSingle() as { data: any };
  if (!session && metaSessionId) {
    const r = await admin.from('irs_call_sessions' as any)
      .select('id, status, callback_status, callback_mode, classified_outcome')
      .eq('id', metaSessionId).maybeSingle() as { data: any };
    session = r.data;
  }

  if (!session) {
    console.warn(`[retell-webhook] no session for ${callId} — possibly a smoke-test call`);
    return NextResponse.json({ received: true, warning: 'session_not_found' });
  }

  // Extract signals from the transcript
  const transcript: string = call.transcript || '';
  const durationMs: number = call.duration_ms || 0;
  const disconnectReason: string | null = call.disconnection_reason || null;
  const signals = extractPpsSignals(transcript, durationMs, disconnectReason);

  // Classify outcome — same precedence the autodial script uses
  const classifiedOutcome =
    signals.agentAnswered ? 'agent_answered'
    : signals.callbackOffered && session.callback_mode === 'irs_callback' ? 'callback_offered'
    : signals.callbackOffered ? 'callback_offered_but_not_taken'
    : signals.overflowRejected ? 'overflow_rejected'
    : signals.announcedWaitMinutes && signals.announcedWaitMinutes > 15 ? 'wait_too_long_no_callback'
    : disconnectReason === 'dial_no_answer' ? 'dial_no_answer'
    : disconnectReason === 'max_duration_reached' ? 'max_duration_reached'
    : 'short_call_no_signal';

  const coachingTags = [
    signals.announcedWaitMinutes !== null ? `wait_${signals.announcedWaitMinutes}min` : null,
    signals.callbackOffered ? 'callback_offered' : 'no_callback_offered',
    signals.overflowRejected ? 'overflow_rejected' : null,
    signals.agentAnswered ? 'agent_answered' : null,
  ].filter(Boolean) as string[];

  // If the call was a callback-mode call and the IRS confirmed acceptance,
  // flip callback_status. Pattern: agent saying "we will call you back"
  // followed by the IRS agreeing or asking for the callback number.
  const acceptedCallback =
    signals.callbackOffered &&
    session.callback_mode === 'irs_callback' &&
    /\b(?:yes|sure|okay|will call|confirmed|noted|on (?:our|the) list)\b/i.test(transcript);

  const updatePatch: Record<string, any> = {
    classified_outcome: classifiedOutcome,
    call_summary: signals.summary,
    coaching_tags: coachingTags,
    irs_agent_name: signals.agentName,
    irs_agent_badge: signals.agentBadge,
    hold_duration_seconds: signals.holdSeconds,
    concatenated_transcript: transcript || null,
  };
  if (acceptedCallback && session.callback_status === 'waiting') {
    updatePatch.callback_status = 'accepted';
    updatePatch.callback_initiated_at = new Date().toISOString();
    // Hold the assigned AI callback number — the inbound handler resolves it.
    updatePatch.callback_state = 'waiting';
  }
  // This IS the inbound callback resume call — the loop is closing. Mark the
  // callback completed; the release block below frees the number.
  if (isCallbackResume) {
    updatePatch.callback_state = 'completed';
  }
  // If the call ended without ever being marked complete, finalize it.
  if (session.status === 'ringing' || session.status === 'initiating') {
    updatePatch.status = disconnectReason === 'dial_no_answer' ? 'failed' : 'completed';
    updatePatch.ended_at = new Date().toISOString();
  }

  await (admin.from('irs_call_sessions' as any) as any).update(updatePatch).eq('id', session.id);

  // No callback was taken on this call → free any AI callback number we'd
  // assigned at fire time so it returns to the pool. (No-op if none assigned /
  // pool unmigrated.)
  if (!acceptedCallback) {
    try { const { releaseCallbackNumber } = await import('@/lib/callback-numbers'); await releaseCallbackNumber(admin, session.id); }
    catch (e) { console.warn('[retell-webhook] callback number release failed:', e instanceof Error ? e.message : e); }
  }

  console.log(
    `[retell-webhook] ${callId} → ${classifiedOutcome} | ` +
    `agent_answered=${signals.agentAnswered} callback_offered=${signals.callbackOffered} ` +
    `accepted=${acceptedCallback} | wait=${signals.announcedWaitMinutes || '-'}min`,
  );

  return NextResponse.json({
    received: true,
    session_id: session.id,
    classified_outcome: classifiedOutcome,
    callback_status_changed: acceptedCallback ? 'accepted' : 'unchanged',
  });
}
