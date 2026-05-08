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
  | 'other';

interface ClassifierInput {
  transcript: string | null | undefined;
  status: string | null | undefined; // session.status from voice provider (completed | failed | etc.)
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

  // High-volume rejection — the canonical IRS phrasing
  if (
    /extremely high call volume/i.test(transcript) ||
    /unable to handle your call at this time/i.test(transcript) ||
    /please try again later.*next business day/i.test(transcript)
  ) {
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

  // Telephony / network failure with non-empty transcript means we got
  // partial audio but the call dropped before the IVR completed. Treat
  // as retryable.
  if (status === 'failed') return 'connection_failed';

  return 'other';
}

/**
 * Convenience: is this outcome eligible for an auto-retry?
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
