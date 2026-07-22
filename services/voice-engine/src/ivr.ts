/**
 * Phase A — IRS PPS IVR navigation.
 *
 * The PPS tree is a known, stable menu; navigating it is a lookup table, not
 * a conversation. Encoding it as data means zero LLM latency/cost, and when
 * the IRS reshuffles the menu (they do), the fix is editing this table — not
 * re-prompting an agent and hoping.
 *
 * Steps fire on TRANSCRIPT MATCH, not timers: ConversationRelay streams the
 * menu audio as `prompt` messages, and we answer each menu as we hear it.
 * A per-step timeout catches menu changes — on timeout we checkpoint
 * `ivr_lost` and end, which the retry classifier treats as retryable.
 *
 * Tree as observed on real PPS calls (May 2026 recordings; verify on first
 * live call): language select → practitioner line routing → CAF entry.
 */

export interface IvrStep {
  /** Case-insensitive substrings; ANY match in the rolling transcript fires the step. */
  match: string[];
  /** DTMF to send ('w' = 0.5s pause). Empty = just wait for this marker. */
  digits: string;
  /** Checkpoint label written to the session when the step fires. */
  label: string;
  /** Seconds to wait for the match before declaring the tree changed. */
  timeoutSec: number;
}

/** {caf} is replaced with the session's CAF number (digits only). */
export const PPS_IVR_PLAN: IvrStep[] = [
  { match: ['for english', 'para continuar en español'], digits: '1', label: 'ivr_language', timeoutSec: 30 },
  { match: ['practitioner priority', 'tax professional'], digits: 'w2', label: 'ivr_practitioner', timeoutSec: 60 },
  { match: ['individual', 'business'], digits: 'w2', label: 'ivr_account_type', timeoutSec: 60 },
  { match: ['centralized authorization file', 'caf number'], digits: 'ww{caf}#', label: 'ivr_caf_entered', timeoutSec: 60 },
];

/**
 * Signals that Phase A is over and Phase B (hold) has begun. The IVR loop
 * hands off to the sentinel the moment one of these lands.
 */
export const HOLD_STARTED_MARKERS = [
  'your call may be monitored',
  'call volume',
  'the next available',
  'currently experiencing',
  'wait time',
  'please continue to hold',
];

/**
 * The overflow rejection — "due to extremely high call volume … call back
 * later" followed by a hangup. Classified terminal-retryable; there is no
 * hold to wait through.
 */
export const OVERFLOW_MARKERS = [
  'unable to handle your call',
  'try your call again later',
  'call back on our next business day',
];

/** Callback offer — accept it and release the line (cheapest path by far). */
export const CALLBACK_OFFER_MARKERS = [
  'receive a return call',
  'callback',
  'call you back',
  'lose your place in line',
];

export function fillCaf(digits: string, caf: string): string {
  return digits.replace('{caf}', caf.replace(/\D/g, ''));
}

export function matchesAny(transcript: string, needles: string[]): boolean {
  const t = transcript.toLowerCase();
  return needles.some((n) => t.includes(n));
}
