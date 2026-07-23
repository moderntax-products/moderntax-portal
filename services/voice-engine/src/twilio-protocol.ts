/**
 * Twilio ConversationRelay wire contract — isolated here so the one thing we
 * don't own (Twilio's message shapes) lives in one file. VERIFY against
 * current Twilio docs before first deploy; everything else in this service
 * depends only on these types and two builder functions.
 *
 * ConversationRelay gives us exactly the split we need: Twilio runs
 * telephony + streaming STT/TTS, and hands this service a websocket with
 * transcribed caller speech in and text-to-speak out. The LLM is entirely
 * ours to invoke — or not invoke, which is the whole point during holds.
 */

/** Messages we RECEIVE on the ConversationRelay websocket. */
export type RelayInbound =
  | { type: 'setup'; sessionId: string; callSid: string; from: string; to: string; customParameters?: Record<string, string> }
  | { type: 'prompt'; voicePrompt: string; last: boolean }        // transcribed speech from the far end
  | { type: 'interrupt'; utteranceUntilInterrupt: string }        // far end spoke over our TTS
  | { type: 'dtmf'; digit: string }
  | { type: 'error'; description: string };

/** Messages we SEND on the ConversationRelay websocket. */
export type RelayOutbound =
  | { type: 'text'; token: string; last: boolean }                // TTS this text
  | { type: 'sendDigits'; digits: string }                        // DTMF toward the IRS ('w' = 0.5s pause)
  | { type: 'end'; handoffData?: string };                        // hang up

/**
 * TwiML for an OUTBOUND leg: dial PPS, then bridge the call audio to our
 * websocket. `params` ride through to the setup message so the socket handler
 * knows which irs_call_sessions row it's driving without a lookup.
 */
export function outboundTwiml(wsUrl: string, params: Record<string, string>): string {
  const parameters = Object.entries(params)
    .map(([k, v]) => `<Parameter name="${escapeXml(k)}" value="${escapeXml(v)}"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${escapeXml(wsUrl)}" transcriptionProvider="deepgram" interruptible="true">
      ${parameters}
    </ConversationRelay>
  </Connect>
</Response>`;
}

/**
 * TwiML for an INBOUND leg — the IRS calling our pool number back. Same
 * bridge; the socket handler resolves the session from the called number via
 * the callback_numbers pool.
 */
export function inboundTwiml(wsUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${escapeXml(wsUrl)}" transcriptionProvider="deepgram" interruptible="true"/>
  </Connect>
</Response>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
