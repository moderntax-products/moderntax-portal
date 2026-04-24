/**
 * Retell AI Client Library
 *
 * Wrapper for the Retell AI REST API — the replacement for Bland AI. We
 * migrated here on 2026-04-24 because Bland retired their programmatic
 * mid-call transfer endpoint (was costing us missed IRS agent handoffs),
 * and their live-listen feature is plan-gated whereas Retell ships it on
 * every plan.
 *
 * Docs: https://docs.retellai.com
 * Base: https://api.retellai.com
 *
 * Conceptual differences from Bland:
 *   • Retell separates the "LLM config" (prompt + tools) from the "Agent"
 *     (voice + behavior) from the "Phone Call" (outbound instance). We
 *     upsert the LLM + Agent once via scripts/retell-setup.ts, then each
 *     call is just a `createPhoneCall()` that references an agent_id.
 *   • Dynamic per-call context goes in `retell_llm_dynamic_variables` — a
 *     flat string→string map the prompt interpolates with {{var_name}}.
 *   • Mid-call transfer is a first-class tool (`transfer_call`) the LLM
 *     can invoke at any point. No API endpoint deprecations.
 *   • Live audio is a wss://.../listen-call/{call_id} URL returned on call
 *     creation — streams PCM Int16 mono at 16kHz exactly like Bland's
 *     former format, so our existing WebSocket player code works unchanged.
 */

const RETELL_API_BASE = 'https://api.retellai.com';

function getApiKey(): string {
  const key = process.env.RETELL_API_KEY;
  if (!key) throw new Error('RETELL_API_KEY environment variable is not set');
  return key;
}

async function retellFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${RETELL_API_BASE}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Retell ${init.method || 'GET'} ${path} ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Types — mirror BlandCallParams / BlandCallResponse so the route layer can
// swap providers without changing shape.
// ---------------------------------------------------------------------------

export interface RetellCallParams {
  expertName: string;
  cafNumber: string;
  expertFax?: string;
  expertPhone?: string;
  expertAddress?: string;
  sorInbox?: string;
  /** Optional voice sample URL for ElevenLabs zero-shot cloning. */
  voiceSampleUrl?: string;

  entities: {
    entityId: string;
    taxpayerName: string;
    taxpayerTid: string;
    tidKind: 'SSN' | 'EIN';
    formType: string;
    years: string[];
  }[];

  metadata: {
    sessionId: string;
    expertId: string;
    assignmentIds: string[];
  };

  callMode?: 'ai_full' | 'hold_and_transfer' | 'irs_callback';
  callbackPhone?: string;
}

export interface RetellCallResponse {
  call_id: string;
  status: string;
  message?: string;
  live_audio_url?: string;
}

export interface RetellCallDetails {
  call_id: string;
  call_status: 'registered' | 'ongoing' | 'ended' | 'error';
  call_type: 'phone_call' | 'web_call';
  start_timestamp?: number;
  end_timestamp?: number;
  recording_url?: string;
  transcript?: string;
  /** Minute-granularity billing figure Retell returns on call-end. */
  call_analysis?: {
    call_successful?: boolean;
    user_sentiment?: string;
    custom_analysis_data?: Record<string, unknown>;
  };
  duration_ms?: number;
  disconnection_reason?: string;
}

// ---------------------------------------------------------------------------
// LLM / Agent management (used by scripts/retell-setup.ts)
// ---------------------------------------------------------------------------

/**
 * Retell tool shape — allowed `type` values (per their API error schema):
 *   custom | end_call | press_digit | bridge_transfer | cancel_transfer | mcp
 *
 * `custom` tools invoke our webhooks mid-call. `bridge_transfer` is the
 * modern replacement for the old "transfer_call" — bridges the call to a
 * pre-configured number when the LLM fires the tool.
 */
export interface RetellTool {
  type: 'custom' | 'end_call' | 'press_digit' | 'bridge_transfer' | 'cancel_transfer';
  name: string;
  description: string;

  // --- custom webhook tool ---
  url?: string;
  method?: 'POST' | 'GET';
  headers?: Record<string, string>;
  speak_during_execution?: boolean;
  speak_after_execution?: boolean;
  execution_message_description?: string;
  response_variables?: string[];
  parameters?: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };

  // --- bridge_transfer ---
  transfer_destination?: {
    type: 'predefined';
    number: string;
  };
  transfer_option?: {
    type: 'cold_transfer';
    show_transferee_as_caller?: boolean;
  };
}

export interface CreateLlmRequest {
  model: string;                    // "gpt-4o", "gpt-4.1", "claude-3.5-sonnet"
  general_prompt: string;           // the "system prompt"
  general_tools: RetellTool[];
  begin_message?: string;
  starting_state?: string;
}

export interface RetellLlm {
  llm_id: string;
  model: string;
  general_prompt: string;
  version: number;
}

export async function createLlm(req: CreateLlmRequest): Promise<RetellLlm> {
  return retellFetch<RetellLlm>('/create-retell-llm', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function updateLlm(llmId: string, req: Partial<CreateLlmRequest>): Promise<RetellLlm> {
  return retellFetch<RetellLlm>(`/update-retell-llm/${llmId}`, {
    method: 'PATCH',
    body: JSON.stringify(req),
  });
}

export async function listLlms(): Promise<RetellLlm[]> {
  return retellFetch<RetellLlm[]>('/list-retell-llms');
}

export interface CreateAgentRequest {
  agent_name: string;
  voice_id: string;                 // e.g. "11labs-Adrian", "openai-Alloy"
  voice_temperature?: number;
  voice_speed?: number;
  responsiveness?: number;          // 0-1, how quickly agent responds
  interruption_sensitivity?: number;
  enable_backchannel?: boolean;
  backchannel_words?: string[];
  language?: string;                // "en-US"
  response_engine: { type: 'retell-llm'; llm_id: string; version?: number };
  max_call_duration_ms?: number;
  pronunciation_dictionary?: { word: string; alphabet: 'ipa'; phoneme: string }[];
  ambient_sound?: string;
  post_call_analysis_data?: { type: string; name: string; description: string }[];
}

export interface RetellAgent {
  agent_id: string;
  agent_name: string;
  voice_id: string;
  response_engine: { type: string; llm_id: string };
}

export async function createAgent(req: CreateAgentRequest): Promise<RetellAgent> {
  return retellFetch<RetellAgent>('/create-agent', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function updateAgent(agentId: string, req: Partial<CreateAgentRequest>): Promise<RetellAgent> {
  return retellFetch<RetellAgent>(`/update-agent/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify(req),
  });
}

export async function listAgents(): Promise<RetellAgent[]> {
  return retellFetch<RetellAgent[]>('/list-agents');
}

// ---------------------------------------------------------------------------
// Phone numbers — provisioned via dashboard or API. Our single IRS-calling
// number is stored in RETELL_IRS_PHONE_NUMBER env.
// ---------------------------------------------------------------------------

export interface RetellPhoneNumber {
  phone_number: string;
  phone_number_pretty: string;
  inbound_agent_id?: string;
  outbound_agent_id?: string;
  nickname?: string;
  area_code?: number;
}

export async function listPhoneNumbers(): Promise<RetellPhoneNumber[]> {
  return retellFetch<RetellPhoneNumber[]>('/list-phone-numbers');
}

export async function createPhoneNumber(req: {
  area_code?: number;
  inbound_agent_id?: string;
  outbound_agent_id?: string;
  nickname?: string;
}): Promise<RetellPhoneNumber> {
  return retellFetch<RetellPhoneNumber>('/create-phone-number', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

// ---------------------------------------------------------------------------
// Outbound call creation — the main runtime API
// ---------------------------------------------------------------------------

export interface CreatePhoneCallRequest {
  from_number: string;
  to_number: string;
  override_agent_id?: string;
  retell_llm_dynamic_variables?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface CreateWebCallRequest {
  agent_id: string;
  retell_llm_dynamic_variables?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface CreatePhoneCallResponse {
  call_id: string;
  call_status: string;
  call_type: 'phone_call';
  from_number: string;
  to_number: string;
}

export interface CreateWebCallResponse {
  call_id: string;
  access_token: string;
  call_type: 'web_call';
}

export async function createPhoneCall(req: CreatePhoneCallRequest): Promise<CreatePhoneCallResponse> {
  return retellFetch<CreatePhoneCallResponse>('/create-phone-call', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function createWebCall(req: CreateWebCallRequest): Promise<CreateWebCallResponse> {
  return retellFetch<CreateWebCallResponse>('/create-web-call', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

// ---------------------------------------------------------------------------
// Mid-call control — the features Bland removed
// ---------------------------------------------------------------------------

/**
 * End an active call. Works on ongoing calls. Retell returns 204 on success.
 */
export async function endCall(callId: string): Promise<void> {
  const res = await fetch(`${RETELL_API_BASE}/v2/end-call/${callId}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${getApiKey()}` },
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.text().catch(() => '');
    throw new Error(`Retell endCall ${res.status}: ${body}`);
  }
}

/**
 * Get call status + transcript + analysis. Use this for live polling (our
 * existing `/api/expert/irs-call/status` route already does this pattern).
 */
export async function getCall(callId: string): Promise<RetellCallDetails> {
  return retellFetch<RetellCallDetails>(`/v2/get-call/${callId}`);
}

/**
 * Live-listen WebSocket URL. Retell returns this directly from call
 * creation metadata, OR via this helper which is a stable
 * URL pattern documented in their realtime docs.
 */
export function getLiveListenUrl(callId: string): string {
  return `wss://api.retellai.com/audio-websocket/${callId}`;
}

// ---------------------------------------------------------------------------
// Prompt/Tool builders — port of lib/bland.ts adaptive prompt to Retell's
// {{variable}} interpolation + tool-calling format.
// ---------------------------------------------------------------------------

/**
 * Build the list of tools the LLM can invoke mid-call. Webhook URLs point
 * at our existing endpoints so server-side handlers don't need rewriting.
 */
export function buildToolsForIrsPps(appUrl: string, webhookSecret: string, callbackPhone: string): RetellTool[] {
  return [
    // --- 1. Bridge-transfer to the practitioner's phone. ---
    {
      type: 'bridge_transfer',
      name: 'transfer_call',
      description:
        'Transfer the call to the tax practitioner as soon as you detect a live IRS agent greeting. ' +
        'Signs: a human voice saying "Thank you for calling", "This is [name]", "How can I help?", or asking for CAF number.',
      transfer_destination: {
        type: 'predefined',
        number: callbackPhone.startsWith('+') ? callbackPhone : `+1${callbackPhone.replace(/\D/g, '')}`,
      },
      transfer_option: { type: 'cold_transfer' },
    },

    // --- 2. Send fax — existing webhook. ---
    {
      type: 'custom',
      name: 'send_fax',
      description:
        'Fax the signed 8821 to the IRS agent when they request it. Provide the fax number the agent gave you and which entity (0-based index) the 8821 is for.',
      url: `${appUrl}/api/expert/irs-call/mid-call-fax`,
      method: 'POST',
      headers: { 'x-bland-secret': webhookSecret },
      speak_during_execution: true,
      execution_message_description: "Say: 'One moment, faxing that over now.'",
      speak_after_execution: true,
      parameters: {
        type: 'object',
        properties: {
          entity_index: {
            type: 'number',
            description: 'Zero-based index of the entity whose 8821 is being faxed',
          },
          fax_number: {
            type: 'string',
            description: 'The fax number the IRS agent provided (10 digits, US)',
          },
          session_id: {
            type: 'string',
            description: 'The ModernTax call session id (echoed from dynamic variables)',
          },
        },
        required: ['entity_index', 'fax_number'],
      },
    },

    // --- 3. Update per-entity status — outcomes, fax confirmations, name mismatches. ---
    {
      type: 'custom',
      name: 'update_entity_status',
      description:
        'Record an outcome for a specific entity. Fire for every important event: transcripts_requested, name_mismatch, agent_unable_to_verify, filing_requirement_confirmed, callback_required.',
      url: `${appUrl}/api/expert/irs-call/status-update`,
      method: 'POST',
      headers: { 'x-bland-secret': webhookSecret },
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'ModernTax call session id' },
          entity_index: { type: 'number', description: 'Zero-based entity index' },
          event: {
            type: 'string',
            description: 'What happened for this entity',
            enum: [
              'transcripts_requested',
              'name_mismatch',
              '8821_not_on_file',
              'fax_received',
              'filing_requirement_confirmed',
              'agent_badge_captured',
              'callback_required',
            ],
          },
          notes: { type: 'string', description: 'Free-form context — agent quotes, specific years, requested forms' },
        },
        required: ['session_id', 'entity_index', 'event'],
      },
    },

    // --- 4. Notify overall call status. ---
    {
      type: 'custom',
      name: 'notify_status',
      description:
        'Report call-level status changes so the ops dashboard reflects reality. Events include wait_estimate, holding, callback_accepted, overflow_rejected, agent_answered.',
      url: `${appUrl}/api/expert/irs-call/transfer-notify`,
      method: 'POST',
      headers: { 'x-bland-secret': webhookSecret },
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'ModernTax call session id' },
          event: {
            type: 'string',
            description: 'The status transition to report',
            enum: [
              'wait_estimate',
              'holding',
              'callback_accepted',
              'overflow_rejected',
              'agent_answered',
            ],
          },
          estimated_wait_minutes: { type: 'number', description: 'Minutes of expected wait if IRS gave an estimate' },
          callback_phone: { type: 'string', description: 'Callback number entered (if event=callback_accepted)' },
        },
        required: ['session_id', 'event'],
      },
    },

    // --- 5. End call cleanly. ---
    {
      type: 'end_call',
      name: 'end_call',
      description:
        'End the call politely when all entities have been processed, the agent has confirmed SOR delivery, and everyone has said goodbye.',
    },

    // --- 6. Press DTMF digits during IVR. ---
    {
      type: 'press_digit',
      name: 'press_digit',
      description:
        'Press a phone keypad digit during the IVR. Use 1 for English, 3 for business accounts. NEVER press digits during recorded announcements.',
    },
  ];
}

/**
 * Full IRS PPS prompt ported from lib/bland.ts#buildAdaptivePrompt.
 * Uses {{variable}} interpolation so per-call context is dynamic at run time
 * (retell_llm_dynamic_variables on createPhoneCall).
 *
 * Dynamic variables expected:
 *   - expert_name, caf_number, expert_fax, expert_phone, expert_address
 *   - sor_inbox (for SOR delivery instruction)
 *   - callback_phone (also baked into transfer_call tool)
 *   - entity_json — JSON-stringified array of { name, tid, tidKind, formType, years, address? }
 *   - session_id
 */
export function buildIrsPpsPrompt(): string {
  return `You are a calm, professional voice agent calling the IRS Practitioner Priority Service (PPS) ON BEHALF OF a tax practitioner. You speak naturally and only read content that the instructions explicitly say to SPEAK aloud — you NEVER narrate the instructions themselves.

=============================================================
CONTEXT — Dynamic variables injected per call. Use these VALUES.
=============================================================
Practitioner name:        {{expert_name}}
CAF number:               {{caf_number}}
Practitioner fax origin:  {{expert_fax}}
SOR inbox:                {{sor_inbox}}
Callback phone:           {{callback_phone}}
Number of accounts:       {{entity_count}}
Entities JSON:            {{entity_json}}
Session id:               {{session_id}}
Practitioner SSN:         {{expert_ssn_for_speech}}
Practitioner DOB:         {{expert_dob_for_speech}}
Credentials available:    {{expert_credentials_available}}

The entities list contains objects with fields: name, tid (9-digit string), tidKind ("SSN" or "EIN"), formType (e.g. "1120S", "1040"), years (array of 4-digit years), address (optional string).

Rules for reading these variables aloud:
- Read names, numbers, and addresses naturally. Never say "underscore".
- For any 9-digit TID or SSN, speak it digit-by-digit with a short pause after the third and fifth digit. Example for 123456789: "one two three, four five, six seven eight nine."
- Form names: say "ten-forty" for 1040, "eleven-twenty" for 1120, "eleven-twenty-S" for 1120S, "nine-forty-one" for 941.
- Tax years: say each one separately. "twenty twenty-two, twenty twenty-three, twenty twenty-four."

=============================================================
PHASE 1 — NAVIGATE THE IRS PPS IVR
=============================================================

The PPS number is 866-860-4259. Flow:

1. The IVR says: "Welcome to the IRS Practitioner Priority Line. To continue in English, press 1."
   → call press_digit with digit="1".

2. The IVR says: "Listen carefully to the following options..."
   → If the first entity's tidKind is "SSN", call press_digit with digit="2" (individual accounts).
   → Otherwise call press_digit with digit="3" (business accounts).

3. Recorded announcements play about Form 2848/8821 processing and practitioner eligibility. STAY SILENT. Do NOT press any keys.

4. Eventually you will hear EITHER:
   a. "We estimate your wait time to be between X and Y minutes." → call notify_status with event="wait_estimate" and estimated_wait_minutes=Y. Move to PHASE 2.
   b. "We are unable to handle your call at this time" or "due to extremely high call volume" → call notify_status with event="overflow_rejected". Say: "Thank you, I'll try again later." Call end_call.

Hard rules for PHASE 1:
- NEVER press keys during recorded announcements.
- NEVER enter a TIN or EIN on the keypad — PPS does not prompt for one.
- When in doubt, WAIT.

=============================================================
PHASE 2 — CALLBACK OR HOLD
=============================================================

Prefer callback.

If the IVR says: "Rather than wait on hold, we can call you back":
  → press_digit with digit="1".
  → WAIT until you hear: "Please enter the 10-digit phone number..."
  → Press each digit of {{callback_phone}} individually.
  → Confirm when asked.
  → call notify_status with event="callback_accepted" and callback_phone="{{callback_phone}}".
  → call end_call.

If no callback is offered:
  → call notify_status with event="holding" and estimated_wait_minutes.
  → STAY SILENT. Do not speak during hold music or recorded loops.

=============================================================
PHASE 3 — LIVE AGENT ANSWERS (the handoff moment)
=============================================================

You know an agent has answered when you hear a HUMAN voice say any of:
  • "Thank you for calling..."
  • "This is [Mr/Ms/Mrs] [Name]" — any name.
  • "May I have your CAF number?"
  • "How can I help you today?"
  • "Practitioner Priority Service" spoken by a person (not the recorded IVR).
  • Any other human voice that is NOT a known recorded loop.

As soon as an agent answers:
  → call notify_status with event="agent_answered".
  → Immediately call transfer_call if transfer is the expected mode — this is the PRIMARY action.

If transfer_call is not yet warranted (e.g. the AI is processing the full call itself), SPEAK this opening, substituting the real values:

"Hi, thank you for taking my call. This is {{expert_name}}, a tax practitioner. My CAF number is {{caf_number}}. I have {{entity_count}} accounts to process today and I have signed 8821 authorizations for all of them."

Then WAIT for the agent to respond before continuing.

=============================================================
PHASE 4 — PROCESS EACH ENTITY (one at a time)
=============================================================

Loop through the entities in entity_json order. Use the entity's field values directly — never say field names aloud.

STEP A — Identify the taxpayer. SPEAK (substituting real values from the entity):

"For my first client, the taxpayer name is [entity.name]. The [say "EIN" if tidKind is EIN else "Social"] is [entity.tid spoken digit-by-digit with pauses]."

For the second entity say "For my second client..." and so on.

STEP B — The agent may request an 8821 fax.

If the agent says: "What's your fax number?" OR "Please fax me the 8821" OR "I don't see the 8821 on file":
  → Ask: "Of course. What fax number should I send it to?"
  → Wait for the fax number.
  → Repeat the fax number back digit-by-digit to confirm.
  → Call send_fax with entity_index (0-based index of current entity), fax_number (digits only), and session_id="{{session_id}}".
  → SPEAK: "One moment, faxing that over now from a {{expert_fax}} area code number. It should arrive in about 30 seconds."
  → WAIT SILENTLY. Do NOT speak until the agent confirms they received the fax OR asks for anything else. Fax confirmation typically takes 2–5 minutes of silence.
  → When the agent confirms receipt ("got it", "I see it", "received"), call update_entity_status with entity_index, event="fax_received".

If the agent says multiple 8821s came through together, do NOT re-fax. Just confirm: "Yes, you should have all the 8821s in that batch."

STEP C — Handle verification probes. The agent may ask any of these:

- "What's the business address?" — read entity.address aloud naturally.
- "What's the name on file / does this match?" — compare to entity.name. If it matches, say "Yes, that's correct." If it doesn't: "The name on our records is [entity.name]. Could you check for variations?"
- "I can't verify this taxpayer" OR "The EIN doesn't match the name" — call update_entity_status with event="name_mismatch" and notes="<agent's exact quote>". Say: "Understood — I'll verify with my client and call back. Can we move to the next one?"
- "What filing requirement is on this account?" — ask: "Could you please read out what's on file for [entity.formType]?" Listen, then call update_entity_status with event="filing_requirement_confirmed" and notes="<what the agent read back>".

STEP D — Authenticate the practitioner (required before transcripts release).

If the agent asks: "What's your Social Security number?" OR "I need your SSN and date of birth" OR "I need to verify your identity" OR any similar ask:

CASE 1 — expert_credentials_available equals "true":
  SPEAK (substitute real values):
  "My social is [read {{expert_ssn_for_speech}} exactly as printed — the commas in it are pauses]. My date of birth is [read {{expert_dob_for_speech}} — it is printed as "M D YYYY", say the month, day of month, then full year]."
  For example if {{expert_dob_for_speech}} is "8 24 1987", say: "August twenty-fourth, nineteen eighty-seven."
  Then wait for the agent to confirm authentication.

CASE 2 — expert_credentials_available equals "false":
  SPEAK: "I apologize — my personal identity verification on file is incomplete. I need to end this call and update my credentials before we can proceed. Thank you."
  Call update_entity_status with event="callback_required" and notes="credentials missing — expert needs to set SSN+DOB".
  Call end_call.

STEP E — Request transcripts. SPEAK (substitute real values):

"I'd like the [entity.formType] Record of Account transcript and Tax Return transcript for tax years [each year spoken individually]."

If the formType contains "1040", also request "and the Wage and Income transcript."

If the agent asked you to verify election status, also say: "Please include the Entity Transcript confirming election status."

STEP F — Confirm SOR inbox delivery.

SPEAK: "Please send these to my SOR inbox. Let me spell it for you."

Then spell {{sor_inbox}} character by character using the NATO alphabet. For EACH character in the string, say:
  Letter A → "Alpha"            Digit 0 → "zero"
  Letter B → "Bravo"            Digit 1 → "one"
  Letter C → "Charlie"          Digit 2 → "two"
  Letter D → "Delta"            Digit 3 → "three"
  Letter E → "Echo"             Digit 4 → "four"
  Letter F → "Foxtrot"          Digit 5 → "five"
  Letter G → "Golf"             Digit 6 → "six"
  Letter H → "Hotel"            Digit 7 → "seven"
  Letter I → "India"            Digit 8 → "eight"
  Letter J → "Juliet"           Digit 9 → "nine"
  Letter K → "Kilo"             Hyphen - → "dash"
  Letter L → "Lima"
  Letter M → "Mike"
  Letter N → "November"
  Letter O → "Oscar"
  Letter P → "Papa"
  Letter Q → "Quebec"
  Letter R → "Romeo"
  Letter S → "Sierra"
  Letter T → "Tango"
  Letter U → "Uniform"
  Letter V → "Victor"
  Letter W → "Whiskey"
  Letter X → "X-ray"
  Letter Y → "Yankee"
  Letter Z → "Zulu"

Example — if {{sor_inbox}} is "MCA-R-31", you say exactly: "Mike, Charlie, Alpha, dash, Romeo, dash, three, one."

After spelling, say: "Did you get that?" and wait for confirmation.

Then call update_entity_status with event="transcripts_requested" and notes describing form/type/years.

STEP G — Accept SLA.

When the agent says "you'll have these in 45 minutes to 48 hours" OR "5 to 10 days by mail", SPEAK: "Thank you. I'll watch my SOR inbox."

STEP H — Next entity.

SPEAK: "Do you have any other questions on this account?" Wait. If yes, answer. Then SPEAK: "No other questions from my end. Can we move to the next one?" Go back to STEP A for the next entity.

=============================================================
PHASE 5 — WRAP UP
=============================================================

After the last entity:
  1. SPEAK: "That's all the accounts I have today. Can you confirm all the transcripts will be delivered to my SOR inbox at [spell {{sor_inbox}} again using NATO]?"
  2. Wait for confirmation.
  3. SPEAK: "Thank you so much for your help. Have a great day."
  4. Call end_call.

=============================================================
HARD RULES — violate any of these and the call fails
=============================================================

1. NEVER say the words "underscore", "dash", "dot", or "bracket" when reading a variable value. If a variable looks like "expert_name" you are reading the TEMPLATE, not the value — stop and use the actual substituted value instead.

2. NEVER read instructional text aloud. Anything between square brackets or inside a "say..." example is INSTRUCTION, not dialogue. If you're unsure whether to say something, don't.

3. ONE entity at a time. Never batch or combine.

4. Silence is SAFE during: hold music, IVR announcements, fax-scanning pauses, long agent pauses while looking up accounts.

5. Respond within 2 seconds to any clearly-human voice. Recorded loops are the only voices to ignore.

6. Never volunteer SSN/DOB unless the agent explicitly asks for identity verification. Then use STEP D rules.

7. If the agent asks "can you repeat that", speak the previous sentence more slowly — NOT louder.

8. If you hear echo feedback from the agent, pause for 2 seconds and speak more slowly. Do not apologize repeatedly — one "sorry about the echo" is enough.

9. If the agent gets frustrated or says "I can't understand you" more than twice, call update_entity_status with event="callback_required" and notes="agent could not verify audio quality", then end_call politely.

10. If the agent asks you to verify something you don't have (address, EIN, SSN for the taxpayer, etc.), say: "Let me check with my client and call back. Could we move to the next account?" Call update_entity_status with event="callback_required".`;
}
