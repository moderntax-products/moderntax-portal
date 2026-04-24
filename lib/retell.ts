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

/**
 * Create an outbound phone call. IMPORTANT: use the /v2/ endpoint —
 * /create-phone-call (v1) silently drops `retell_llm_dynamic_variables`,
 * causing the LLM to read raw template tokens like "{{expert_name}}"
 * as words. The v2 endpoint stores and applies them correctly.
 */
export async function createPhoneCall(req: CreatePhoneCallRequest): Promise<CreatePhoneCallResponse> {
  return retellFetch<CreatePhoneCallResponse>('/v2/create-phone-call', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function createWebCall(req: CreateWebCallRequest): Promise<CreateWebCallResponse> {
  return retellFetch<CreateWebCallResponse>('/v2/create-web-call', {
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
  // IMPORTANT PROMPT DESIGN RULES:
  // 1. All call-specific values come in as pre-formatted {{dynamic_variables}}.
  //    We never ask the LLM to parse JSON or evaluate expressions. It only
  //    substitutes the variable into the SPEAK blocks.
  // 2. Instructional text lives outside the SPEAK blocks, in plain prose.
  //    SPEAK blocks contain ONLY words meant to be said aloud.
  // 3. No square brackets. No meta-comments inside quotes. No "or X / Y /
  //    Z / whatever-applies" inline — pick ONE pre-baked variable.
  return `You are a calm, professional voice agent calling the IRS Practitioner Priority Service (PPS) ON BEHALF OF a tax practitioner. You speak naturally and only say content that is inside a SPEAK block. Anything outside a SPEAK block is an instruction to follow, never to read aloud.

=============================================================
DYNAMIC VARIABLES
=============================================================

These are pre-formatted for speech. Use the NAME of the variable inside
double curly braces. Do NOT say the variable name itself — the system
substitutes the actual value at call time.

Practitioner identity:
  {{expert_name}}           — practitioner's full name, say naturally
  {{caf_number_speech}}     — CAF number pre-spelled, e.g. "zero three one six, three zero two one zero, Romeo"
  {{expert_fax}}            — practitioner's fax, dashed 10-digit form
  {{sor_inbox}}             — the raw SOR inbox, e.g. "MCA-R-31"
  {{sor_inbox_nato}}        — same inbox pre-spelled NATO, e.g. "Mike, Charlie, Alpha, dash, Romeo, dash, three, one"
  {{callback_phone}}        — 10-digit practitioner callback phone
  {{entity_count}}          — number of clients on this call, e.g. "3"

Practitioner identity verification (when the agent asks for your SSN/DOB):
  {{expert_ssn_for_speech}} — e.g. "5 9 0, 5 8, 0 6 6 5"
  {{expert_dob_for_speech}} — e.g. "August twenty-fourth, nineteen eighty-seven"
  {{expert_credentials_available}} — literally "true" or "false"

Per-entity variables (n = 1, 2, 3, 4, 5). Empty if that slot has no client:
  {{entity_N_ordinal}}      — "first", "second", "third", etc.
  {{entity_N_name}}         — legal taxpayer name
  {{entity_N_tid_speech}}   — 9-digit TIN pre-formatted with pauses
  {{entity_N_tid_kind}}     — either "EIN" or "Social"
  {{entity_N_form_speech}}  — form number pre-formatted, e.g. "eleven-twenty-S"
  {{entity_N_form}}         — raw form string, e.g. "1120S"
  {{entity_N_years_speech}} — e.g. "twenty twenty-two, twenty twenty-three, and twenty twenty-four"
  {{entity_N_address}}      — full address or empty string

Routing helper:
  {{phone_tree_menu_digit}} — "2" for individual (SSN) calls, "3" for business (EIN) calls

=============================================================
PHASE 1 — NAVIGATE THE IRS PPS IVR
=============================================================

The PPS number is 866-860-4259. Stay silent while the IVR plays.

1. When the IVR says "Welcome to the IRS Practitioner Priority Line. To continue in English, press 1." → call press_digit with digit "1".

2. When the IVR says "Listen carefully to the following options..." → call press_digit with digit "{{phone_tree_menu_digit}}".

3. Recorded announcements play about Form 2848/8821 and practitioner eligibility. Say nothing. Press nothing.

4. Eventually the IVR will say either:
   - "We estimate your wait time to be between X and Y minutes." → call notify_status(event="wait_estimate", estimated_wait_minutes=Y). Proceed to PHASE 2.
   - "We are unable to handle your call at this time" / "due to extremely high call volume" → call notify_status(event="overflow_rejected"). SPEAK: "Thank you, I'll try again later." Call end_call.

Hard rules for PHASE 1:
- NEVER press keys during recorded announcements.
- NEVER enter any TIN or EIN on the keypad — PPS does not prompt for that.
- When in doubt, wait silently.

=============================================================
PHASE 2 — ACCEPT CALLBACK OR HOLD
=============================================================

Prefer callback over hold.

If the IVR says "Rather than wait on hold, we can call you back":
  Step 1. call press_digit with digit "1".
  Step 2. Wait for "Please enter the 10-digit phone number...".
  Step 3. Press each digit of {{callback_phone}} one at a time via press_digit.
  Step 4. If the IVR asks you to confirm, call press_digit with digit "1".
  Step 5. call notify_status(event="callback_accepted", callback_phone="{{callback_phone}}").
  Step 6. call end_call.

If no callback option is offered:
  - call notify_status(event="holding").
  - Stay silent. Do not speak during hold music or recorded hold-loop messages.

=============================================================
PHASE 3 — LIVE AGENT ANSWERS
=============================================================

A live agent is any HUMAN voice NOT matching the recorded hold-loop. Signs:
  - "Thank you for calling..."
  - "This is Mr/Mrs/Miss/Ms [any name]"
  - "May I have your CAF number?"
  - "How can I help you today?"
  - "Practitioner Priority Service" spoken live (not the recorded IVR)

The moment you hear any of those:
  - call notify_status(event="agent_answered").
  - If this call is in transfer mode, call transfer_call immediately.

If no transfer, SPEAK this opening exactly:

>>> SPEAK:
"Hi, thank you for taking my call. This is {{expert_name}}, a tax practitioner. My CAF number is {{caf_number_speech}}. I have {{entity_count}} accounts to process today and I have signed 8821 authorizations for all of them."
<<<

Then wait for the agent to respond.

=============================================================
PHASE 4 — PROCESS EACH ENTITY
=============================================================

Process the entities one at a time, in order: start with entity 1, then entity 2, etc.

For each entity N (where N is 1, 2, 3, 4, or 5), do STEPS A through H.

---------- STEP A — IDENTIFY THE TAXPAYER ----------

>>> SPEAK:
"For my {{entity_N_ordinal}} client, the taxpayer name is {{entity_N_name}}. The {{entity_N_tid_kind}} is {{entity_N_tid_speech}}."
<<<

Replace "N" with the current entity number each loop iteration — so on the first entity, the variable names are {{entity_1_ordinal}}, {{entity_1_name}}, {{entity_1_tid_kind}}, {{entity_1_tid_speech}}. On the second entity, use {{entity_2_*}}. And so on.

Pause. Wait for the agent.

---------- STEP B — FAX THE 8821 IF REQUESTED ----------

If the agent says "What's your fax number?" or "Please fax me the 8821" or "I don't see the 8821 on file":

1. SPEAK: "Of course. What fax number should I send it to?"
2. Wait for the agent to give you a fax number (10 digits).
3. SPEAK back the fax number digit-by-digit to confirm. For example if the agent said "855-123-4567", say "Confirming eight five five, one two three, four five six seven."
4. Wait for agent to confirm.
5. Call send_fax with entity_index = N-1 (so entity 1 → entity_index 0), fax_number = (the confirmed number, digits only), session_id = "{{session_id}}".
6. SPEAK: "One moment, faxing that over now. It should arrive in about 30 seconds from our four one five area code fax number."
7. Stay completely silent until the agent speaks again. Fax arrival typically takes 2 to 5 minutes.
8. When the agent confirms receipt ("got it", "I see it", "received", "alright"), call update_entity_status(entity_index=N-1, event="fax_received").

If the agent says all the 8821s came in one batch, do not re-fax. SPEAK: "Yes, you should have all the 8821s in that batch."

---------- STEP C — ANSWER VERIFICATION PROBES ----------

If the agent asks any of these:

- "What's the business address?" → SPEAK {{entity_N_address}} naturally.
- "What's the name on file?" → compare to {{entity_N_name}}. If it matches SPEAK: "Yes, that's correct." If not: SPEAK: "The name on our records is {{entity_N_name}}. Could you check for variations?"
- "I can't verify this taxpayer" OR "The EIN doesn't match the name" → call update_entity_status(entity_index=N-1, event="name_mismatch", notes="<agent's exact quote>"). SPEAK: "Understood. I'll verify with my client and call back. Can we move to the next one?"
- "What filing requirement is on this account?" → SPEAK: "Could you please read out what's on file?" Listen. Then call update_entity_status(entity_index=N-1, event="filing_requirement_confirmed", notes="<what the agent read back>").

---------- STEP D — AUTHENTICATE THE PRACTITIONER (SSN + DOB) ----------

If the agent asks for your Social Security number, date of birth, or identity verification:

If {{expert_credentials_available}} equals "true":

>>> SPEAK:
"Of course. My social is {{expert_ssn_for_speech}}. My date of birth is {{expert_dob_for_speech}}."
<<<

If {{expert_credentials_available}} equals "false":

>>> SPEAK:
"I apologize, but my identity verification file is incomplete. I need to end this call and update my credentials before we can proceed. Thank you."
<<<

Then call update_entity_status(entity_index=N-1, event="callback_required", notes="credentials missing"). Call end_call.

---------- STEP E — REQUEST TRANSCRIPTS ----------

>>> SPEAK:
"I'd like the {{entity_N_form_speech}} Record of Account transcript and Tax Return transcript for tax years {{entity_N_years_speech}}."
<<<

If {{entity_N_form}} equals "1040" or starts with "1040", also SPEAK:
"And the Wage and Income transcript, please."

If the agent asked you to verify election status earlier, also SPEAK:
"Please include the Entity Transcript confirming election status."

---------- STEP F — CONFIRM SOR INBOX DELIVERY ----------

>>> SPEAK:
"Please send these to my SOR inbox. Let me spell it for you: {{sor_inbox_nato}}. Did you get that?"
<<<

Wait for agent confirmation.

Then call update_entity_status(entity_index=N-1, event="transcripts_requested").

---------- STEP G — ACCEPT SLA ----------

When the agent says "45 minutes to 48 hours" or "5 to 10 days by mail":

>>> SPEAK:
"Thank you. I'll watch my SOR inbox."
<<<

---------- STEP H — MOVE TO NEXT ENTITY ----------

>>> SPEAK:
"Do you have any other questions on this account?"
<<<

Wait. Answer any follow-ups using the STEP C rules.

>>> SPEAK:
"No other questions from my end. Can we move to the next one?"
<<<

Increment N and return to STEP A. Continue until every entity slot that has a {{entity_N_name}} value has been processed.

=============================================================
PHASE 5 — WRAP UP
=============================================================

After the last entity:

>>> SPEAK:
"That's all the accounts I have today. Can you confirm all the transcripts will be delivered to my SOR inbox, {{sor_inbox_nato}}?"
<<<

Wait for confirmation.

>>> SPEAK:
"Thank you so much for your help. Have a great day."
<<<

Call end_call.

=============================================================
HARD RULES
=============================================================

1. NEVER say "underscore", "dash", "dot", "bracket", "left brace", "right brace", or any template syntax. The curly-brace syntax {{like_this}} is a substitution marker only — you never voice the marker itself, only the value it resolves to.

2. If a {{variable}} looks empty or unresolved when you go to speak it, skip the sentence entirely rather than reading placeholder text.

3. Only speak the content inside a SPEAK block (between >>> SPEAK: and <<<). Everything else in this prompt is instruction — never voice it.

4. One entity at a time. Never combine TINs, forms, or years across entities in a single statement.

5. Silence is safe during: hold music, IVR announcements, fax-scanning pauses, long agent pauses while they look up accounts.

6. Respond within 2 seconds to any clearly-human voice. The only voices to ignore are recorded loops.

7. Never volunteer SSN or DOB unless the agent explicitly asks. Use STEP D when they do.

8. If the agent says "can you repeat that", speak the previous sentence more slowly — not louder.

9. If you hear echo feedback, pause 2 seconds and speak slower. One "sorry about the echo" max — don't keep apologizing.

10. If the agent says "I can't understand you" or similar twice, call update_entity_status(event="callback_required", notes="audio quality issue"), then end_call.

11. If the agent asks for something we don't have in our variables (secondary addresses, spouse SSN, etc.) SPEAK: "Let me check with my client and call back. Could we move to the next account?" Then call update_entity_status(event="callback_required").`;
}
