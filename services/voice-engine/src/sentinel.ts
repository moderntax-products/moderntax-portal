/**
 * Phase B — the hold sentinel.
 *
 * This is the module that makes the custom engine worth building: during the
 * 30–90 minute hold that is ~62% of a PPS call, NOTHING here calls an LLM.
 * We watch the transcript stream for the handful of patterns that mean a
 * human arrived, and we never speak. A managed platform runs (and bills) an
 * agent for this entire stretch, and its silence/max-duration heuristics are
 * what kill long holds — the 65-minute drop that motivated this rewrite.
 *
 * Detection is deliberately dumb and cheap: hold audio is music + recorded
 * announcements on a loop; a human agent opens with a name/badge script.
 * Repetition tracking separates the loop from fresh speech.
 */

const AGENT_GREETING_PATTERNS: RegExp[] = [
  /my (name|id|badge)/i,
  /badge (number|id)/i,
  /this is (mr|ms|mrs|miss|agent|officer)?\s*\.?\s*\w+/i,
  /employee (id|number)/i,
  /how (can|may) i (help|assist)/i,
  /(am i )?speaking with/i,
  /can i (have|get) your (caf|name|number)/i,
];

/** Announcement lines the hold loop repeats — never treat these as a human. */
const HOLD_LOOP_PATTERNS: RegExp[] = [
  /call may be (monitored|recorded)/i,
  /continue to hold/i,
  /next available (representative|assistor|agent)/i,
  /thank you for your patience/i,
  /visit (www|irs)\.gov/i,
  /did you know/i,
];

export interface SentinelVerdict {
  humanDetected: boolean;
  /** The utterance that tripped detection — logged for tuning. */
  trigger: string | null;
}

export class HoldSentinel {
  private seenUtterances = new Map<string, number>();
  private lastActivityAt = Date.now();

  /**
   * Feed every transcript chunk during hold. Returns a verdict; the caller
   * flips to Phase C only on humanDetected.
   */
  observe(utterance: string): SentinelVerdict {
    const text = utterance.trim();
    this.lastActivityAt = Date.now();
    if (!text) return { humanDetected: false, trigger: null };

    // Known hold-loop content is never a human, no matter what else matches.
    if (HOLD_LOOP_PATTERNS.some((p) => p.test(text))) {
      this.remember(text);
      return { humanDetected: false, trigger: null };
    }

    if (AGENT_GREETING_PATTERNS.some((p) => p.test(text))) {
      return { humanDetected: true, trigger: text };
    }

    // A phrase we've heard 2+ times is the announcement loop even if our
    // pattern list missed it. FRESH speech that isn't loop content and isn't
    // a greeting still wakes Phase C after two consecutive novel utterances —
    // a human who skipped the script (it happens) must not be left talking
    // to hold silence.
    const repeats = this.remember(text);
    if (repeats === 1) {
      this.novelStreak += 1;
      if (this.novelStreak >= 2) return { humanDetected: true, trigger: text };
    } else {
      this.novelStreak = 0;
    }
    return { humanDetected: false, trigger: null };
  }

  private novelStreak = 0;

  /** Seconds since the last transcript chunk — the line-went-dead detector. */
  silenceSeconds(): number {
    return (Date.now() - this.lastActivityAt) / 1000;
  }

  private remember(text: string): number {
    // Normalize aggressively: the loop's re-transcriptions differ slightly.
    const key = text.toLowerCase().replace(/[^a-z ]/g, '').slice(0, 80);
    const n = (this.seenUtterances.get(key) || 0) + 1;
    this.seenUtterances.set(key, n);
    return n;
  }
}
