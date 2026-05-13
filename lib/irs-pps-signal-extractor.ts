/**
 * Extract IRS PPS health signals from a Retell call transcript.
 *
 * Every outbound IRS PPS call we make doubles as a free real-time poll
 * of IRS queue health. The IVR announces wait time, may or may not
 * offer a callback, and the agent (when reached) introduces themselves
 * with a name + ID/badge. All of that is observable in the transcript
 * we already get from Retell's get-call API.
 *
 * Driver: 2026-05-13 — Matt wants real-time IRS PPS data on every call
 * so we can inform customer turnaround-time expectations from observed
 * conditions, not just historical averages.
 *
 * Returns structured fields suitable for persisting on irs_call_sessions
 * (using existing columns: irs_agent_name, irs_agent_badge, hold_duration_seconds)
 * plus a few new structured fields we'll store in classified_outcome
 * or a separate analytics JSONB column.
 */

export interface PpsCallSignals {
  /** IRS-announced wait time in minutes (from "wait time X minutes" IVR). */
  announcedWaitMinutes: number | null;
  /** True if the IVR explicitly offered a callback during the call. */
  callbackOffered: boolean;
  /** True if a live IRS agent answered (not just IVR/hold). */
  agentAnswered: boolean;
  /** Agent's stated name, e.g. "Ms. Johnson" / "Mr. Smith". */
  agentName: string | null;
  /** Agent's badge / ID number (10 digits, IRS standard). */
  agentBadge: string | null;
  /** Total time in seconds spent on hold before agent connect / hangup. */
  holdSeconds: number | null;
  /** Was the call refused with "we cannot handle your call at this time" overflow message? */
  overflowRejected: boolean;
  /** Raw IVR / hold-loop messages we heard (for trend analysis). */
  irvMessages: string[];
  /** Plain-language summary suitable for the admin dashboard. */
  summary: string;
}

export function extractPpsSignals(
  transcript: string,
  durationMs: number,
  disconnectionReason: string | null,
): PpsCallSignals {
  const text = transcript || '';
  const result: PpsCallSignals = {
    announcedWaitMinutes: null,
    callbackOffered: false,
    agentAnswered: false,
    agentName: null,
    agentBadge: null,
    holdSeconds: null,
    overflowRejected: false,
    irvMessages: [],
    summary: '',
  };

  // ---- 1. Announced wait time ----
  // IRS phrases observed in production:
  //   "wait time to be greater than sixty minutes"
  //   "wait time to be between thirty and sixty minutes"  ← upper bound
  //   "wait time is approximately fifteen minutes"
  //   "estimated wait time is X minutes"
  // For "between X and Y" we record Y (upper bound) — it's the conservative
  // SLA estimate to surface to customers.
  const betweenMatch = text.match(/wait time (?:to be |is )?between (\w+(?:[-\s]\w+)?) and (\w+(?:[-\s]\w+)?) minutes?/i);
  if (betweenMatch) {
    const upper = parseWordOrDigitToMinutes(betweenMatch[2]);
    if (upper !== null) {
      result.announcedWaitMinutes = upper;
      const lower = parseWordOrDigitToMinutes(betweenMatch[1]);
      result.summary = `IRS announced wait ${lower !== null ? lower + '–' : ''}${upper} min`;
    }
  }
  if (result.announcedWaitMinutes === null) {
    const waitPatterns = [
      /wait time (?:to be |is )?(?:approximately |about )?greater than (\w+(?:[-\s]\w+)?) minutes?/i,
      /wait time (?:to be |is )?(?:approximately |about )?(\w+(?:[-\s]\w+)?) minutes?/i,
      /estimate(?:d)? (?:your )?wait (?:time )?(?:to be |is )?(\w+) minutes?/i,
    ];
    for (const p of waitPatterns) {
      const m = text.match(p);
      if (m) {
        const n = parseWordOrDigitToMinutes(m[1]);
        if (n !== null) {
          result.announcedWaitMinutes = n;
          if (/greater than/i.test(m[0])) {
            result.summary = `IRS announced wait > ${n} min`;
          } else {
            result.summary = `IRS announced wait ~${n} min`;
          }
          break;
        }
      }
    }
  }

  // ---- 2. Callback offered? ----
  // IVR phrases include: "we can call you back", "press 1 to receive a callback",
  // "schedule a return call", "callback option"
  const callbackPhrases = [
    /we can call you back/i,
    /(?:press \w+ to )?receive a call ?back/i,
    /schedule a return call/i,
    /courtesy call ?back/i,
    /to request a call ?back/i,
  ];
  for (const p of callbackPhrases) {
    if (p.test(text)) {
      result.callbackOffered = true;
      break;
    }
  }

  // ---- 3. Overflow rejection ----
  // IRS phrase: "We are unable to handle your call at this time"
  if (/unable to handle your call at this time|please try again later/i.test(text)) {
    result.overflowRejected = true;
  }

  // ---- 4. Agent answered? ----
  // Heuristics: agent introductions, badge number patterns, "May I have your CAF"
  const agentSignals = [
    /thank you for calling.{0,30}practitioner priority/i,
    /this is (?:Ms?|Mrs|Miss|Mr)\.?\s+\w+/i,
    /how (?:can|may) I help you/i,
    /(?:can|could|may) I have your CAF/i,
    /\b\d{10}\b.{0,50}badge/i,  // 10-digit badge number nearby
  ];
  for (const p of agentSignals) {
    if (p.test(text)) {
      result.agentAnswered = true;
      break;
    }
  }

  // Agent name
  const nameMatch = text.match(/(?:this is|my name is|speaking with)\s+((?:Ms?|Mrs|Miss|Mr)\.?\s+[A-Z][a-z]+)/i);
  if (nameMatch) result.agentName = nameMatch[1];

  // Agent badge (IRS uses 10-digit IDs)
  const badgeMatch = text.match(/(?:badge|ID|number)\s*(?:is\s*)?(\d{10})\b/i);
  if (badgeMatch) result.agentBadge = badgeMatch[1];

  // ---- 5. Hold time ----
  // Use total duration as a coarse proxy; the precise hold-duration is
  // tracked separately by Retell's notify_status events (hold_start_at vs
  // agent_answered_at) but if those are missing this is a reasonable fallback.
  if (durationMs && !result.agentAnswered) {
    result.holdSeconds = Math.floor(durationMs / 1000);
  }

  // ---- 6. IVR / hold-loop messages catalog ----
  // Pull out the longer recorded-announcement segments for trend tracking.
  const ivrFragments = text.match(/(?:User:|IVR:)\s*([^]{30,400}?)(?=\n\s*(?:User:|Agent:|$))/g);
  if (ivrFragments) {
    result.irvMessages = ivrFragments.slice(0, 8).map(f => f.replace(/^(?:User|IVR):\s*/, '').trim().slice(0, 300));
  }

  // ---- 7. Compose summary if not set ----
  if (!result.summary) {
    const parts: string[] = [];
    if (result.overflowRejected) parts.push('IRS overflow — call refused');
    if (result.agentAnswered) parts.push(`agent reached${result.agentName ? ` (${result.agentName})` : ''}`);
    if (result.callbackOffered) parts.push('callback offered');
    if (disconnectionReason) parts.push(`ended: ${disconnectionReason}`);
    result.summary = parts.length > 0
      ? parts.join(' · ')
      : `call ${durationMs ? Math.round(durationMs / 1000) + 's' : 'completed'}, no signals extracted`;
  }

  return result;
}

/** "sixty" → 60, "15" → 15, "fifteen" → 15. Returns null if unparseable. */
function parseWordOrDigitToMinutes(s: string): number | null {
  if (!s) return null;
  const clean = s.trim().toLowerCase().replace(/-/g, ' ');
  // Digit?
  const digit = clean.match(/^\d+$/);
  if (digit) return parseInt(clean, 10);
  // English number words (basic — covers 1-90 for our purposes)
  const ones: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  };
  const tens: Record<string, number> = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  };
  if (clean in ones) return ones[clean];
  if (clean in tens) return tens[clean];
  // "twenty five" / "thirty-five"
  const parts = clean.split(/\s+/);
  if (parts.length === 2 && parts[0] in tens && parts[1] in ones) {
    return tens[parts[0]] + ones[parts[1]];
  }
  return null;
}
