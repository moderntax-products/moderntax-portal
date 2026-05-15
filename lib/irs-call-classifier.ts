/**
 * IRS PPS call outcome classifier — pure function over a session row.
 *
 * Reads the post-call transcript and the session's status to classify
 * what actually happened. The auto-retry loop in the call-completion
 * webhook keys off this output to decide whether to fire another call.
 *
 * Phrasing samples confirmed from real production call transcripts
 * (Apr 30 2026 morning calls):
 *
 *   "We are sorry. But due to extremely high call volume in the topic
 *    you requested, we are unable to handle your call at this time.
 *    Please try again later. Or on our next business day."
 *
 * Outcomes:
 *   - high_volume_rejected → IRS hung up before connecting; eligible for auto-retry.
 *   - callback_scheduled    → IRS confirmed a return call to the expert's number; chain ends in success.
 *   - agent_reached         → AI made it to a human agent; chain ends in success.
 *   - connection_failed     → Telephony failure (no IRS audio at all); eligible for auto-retry.
 *   - other                 → Anything else — admin reviews manually, no auto-retry.
 */

export type IrsCallOutcome =
  | 'high_volume_rejected'
  | 'wait_too_long_no_callback'
  | 'callback_scheduled'
  | 'agent_reached'
  | 'connection_failed'
  | 'agent_premature_hangup'  // MOD-226: our Retell agent gave up without IRS rejection
  | 'other';

interface ClassifierInput {
  transcript: string | null | undefined;
  status: string | null | undefined; // session.status from voice provider (completed | failed | etc.)
  /**
   * Retell's `disconnection_reason` from the call object. Critical for
   * MOD-226: when this is `user_hangup` (= our agent ended the call) AND
   * the transcript has no rejection phrase AND no agent was reached, the
   * classification is `agent_premature_hangup` (the bug), not the
   * misleading `high_volume_rejected` we used to default to.
   *
   * Common values: 'user_hangup' (caller side), 'callee_hangup' (IRS),
   * 'agent_hangup' (Retell agent), 'call_transfer', 'inactivity',
   * 'machine_detected'. Treat 'user_hangup' and 'agent_hangup' as
   * "our side ended it" for purposes of detecting MOD-226.
   */
  disconnectionReason?: string | null;
  /** Total duration in seconds — used for the premature-hangup heuristic. */
  durationSeconds?: number | null;
}

/**
 * Phrase-match the transcript first (most authoritative), fall back to
 * status. Order matters: callback / agent-reached take precedence over
 * high-volume since a call could rotate through both ("high volume,
 * here's a callback option").
 */
export function classifyCallOutcome(input: ClassifierInput): IrsCallOutcome {
  const transcript = (input.transcript || '').toLowerCase();
  const status = (input.status || '').toLowerCase();

  // Empty / very short transcript suggests telephony failure
  if (!transcript || transcript.length < 50) {
    if (status === 'failed') return 'connection_failed';
    return 'other';
  }

  // Callback scheduled — search FIRST so it beats the high-volume phrase
  // when both appear in the same call (IRS first announces high volume,
  // then offers a callback path).
  if (
    /(we'?ll call you back|return call|callback (has been )?scheduled|expect (a )?call back|call you back at)/i.test(transcript)
  ) {
    return 'callback_scheduled';
  }

  // Agent reached — look for explicit agent identification or hold-queue exit
  if (
    /(this is .{2,30} (with|from) (the )?(internal revenue|i\.?r\.?s\.?))|(my name is .{2,30}(,| and) (i'm |i am )?(with|from) the (i\.?r\.?s\.?|internal revenue))|(may i have your name|may i help you)/i.test(transcript)
  ) {
    return 'agent_reached';
  }

  // High-volume rejection — STRICT match on canonical IRS phrasing.
  // MOD-226: pre-fix, this clause matched too liberally and was the source
  // of every fake `high_volume_rejected` tag in the irs_call_sessions
  // table. The phrases below now require the FULL canonical IRS recording,
  // not isolated benign fragments.
  const strictRejectionPatterns = [
    /\bdue to (?:extremely |unusually )?high call volume[\s\S]{0,80}\bunable to (?:handle|take|process) your call/i,
    /\bwe are unable to (?:handle|take|process) your call (?:at this time|right now)/i,
    /\bplease (?:try again|call back).{0,40}(?:next business day|tomorrow|during normal business hours)/i,
  ];
  if (strictRejectionPatterns.some(p => p.test(transcript))) {
    return 'high_volume_rejected';
  }

  // Wait > 15 min with no callback offered — AI hung up. Detect by
  // (a) hearing a wait estimate followed by hold music with no callback
  // prompt, or (b) the AI's own end-of-call note via notify_status
  // (which writes classified_outcome directly — this is the fallback
  // for transcripts where the prompt phrasing leaks through).
  if (
    /wait.*(longer than|more than|over)\s*(fifteen|15)\s*minutes/i.test(transcript) &&
    !/(call you back|callback)/i.test(transcript)
  ) {
    return 'wait_too_long_no_callback';
  }

  // MOD-226 — agent_premature_hangup detection.
  //
  // If our side ended the call (user_hangup or agent_hangup), the call
  // had IRS audio (transcript >= 50 chars passed earlier guard), no agent
  // was reached, no callback was scheduled, no canonical rejection phrase
  // was heard, and duration was short (< 10 minutes), then this is the
  // MOD-226 signature: our Retell agent gave up on its own without any
  // IRS rejection. Distinct from `high_volume_rejected` because there
  // was no actual rejection — the agent hallucinated one or got
  // impatient with the long disclaimer phase.
  //
  // This outcome should NOT auto-retry the same way as a real rejection
  // — see isRetryableOutcome() — because retrying with the same prompt
  // produces the same bug. Better to surface for prompt-tuning.
  const ourSideEndedCall = (input.disconnectionReason || '').toLowerCase() === 'user_hangup'
    || (input.disconnectionReason || '').toLowerCase() === 'agent_hangup';
  const callShorterThanTenMinutes = (input.durationSeconds || Infinity) < 600;
  if (ourSideEndedCall && callShorterThanTenMinutes) {
    return 'agent_premature_hangup';
  }

  // Telephony / network failure with non-empty transcript means we got
  // partial audio but the call dropped before the IVR completed. Treat
  // as retryable.
  if (status === 'failed') return 'connection_failed';

  return 'other';
}

/**
 * Convenience: is this outcome eligible for an auto-retry?
 *
 * Notably `agent_premature_hangup` is NOT auto-retryable — repeating the
 * same call with the same prompt produces the same bug, so the system
 * surfaces these for prompt-tuning instead of burning more Retell
 * sessions on a known-broken pattern.
 */
export function isRetryableOutcome(outcome: IrsCallOutcome): boolean {
  return (
    outcome === 'high_volume_rejected' ||
    outcome === 'connection_failed' ||
    outcome === 'wait_too_long_no_callback'
  );
}

/**
 * Convenience: is this outcome a terminal-success state for the chain?
 */
export function isTerminalSuccess(outcome: IrsCallOutcome): boolean {
  return outcome === 'agent_reached' || outcome === 'callback_scheduled';
}
