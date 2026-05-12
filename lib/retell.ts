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
        'Report call-level status changes so the ops dashboard reflects reality. Events include wait_estimate, holding, callback_accepted, overflow_rejected, wait_too_long_no_callback, agent_answered.',
      url: `${appUrl}/api/expert/irs-call/status-update`,
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
              'wait_too_long_no_callback',
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
  // PROMPT DESIGN RULES (informed by Matt's 4/25 debrief on a real PSTN test):
  //
  // 1. The AI is a PASSIVE RESPONDER. The IRS agent drives the entire
  //    conversation with a fixed sequence of questions. The AI listens,
  //    answers tersely, then waits for the next question.
  //
  // 2. NEVER ask questions back to the IRS agent. Never say "do you have
  //    any other questions?", "anything else?", "shall we move on?", etc.
  //    The IRS agent is the one driving — they will ask "next client?"
  //    when they're ready.
  //
  // 3. NO MARKERS in the prompt. Previous version used >>> SPEAK: and <<<
  //    around dialogue blocks; the AI read "SPEAK" aloud as a literal
  //    word. Plain English only. Quoted dialogue lives inside instruction
  //    sentences ("when the agent asks X, you say: '<exact line>'.")
  //
  // 4. Answers are TERSE — one sentence max. Never combine multiple data
  //    points (e.g. don't say "I'm calling for 3 clients and need 1040s
  //    for 2022-2024" — wait for each question separately).
  //
  // 5. "Record of account transcript" is said EXPLICITLY upfront when asked
  //    for transcript types. "Account transcript" alone has caused
  //    confusion in real calls.
  return `==================================================================
CRITICAL — READ FIRST. This rule overrides everything else in this prompt.
==================================================================

THERE IS NO HUMAN PRACTITIONER ON THIS PHONE CALL. The only people on
the line are you (the AI) and the IRS — either the IRS automated IVR /
hold music, or eventually a live IRS agent. NOBODY ELSE.

This means:
  - You NEVER ask anyone "would you like to...", "should I...", "shall
    I continue holding?", or any other question that expects a human on
    your side of the line to answer. There is no such human. They cannot
    answer.
  - If you find yourself uncertain about what to do next, you DO NOT
    stall by asking the question out loud. Instead, you make the
    decision yourself using the rules in PHASE 2 below, then either
    take the action or call end_call to bail.
  - The ONLY voices you respond to are voices from the IRS line itself.
    Recorded IVR messages, hold music, and live IRS agents are the only
    inputs that should trigger you to speak or act.

FORBIDDEN PHRASES — never say any of these or anything similar:
  - "Would you like to request a callback..."
  - "Should I continue holding?"
  - "Do you want me to..."
  - "Would you prefer that I..."
  - "How would you like to proceed?"
  - "I am still holding for the next available representative" (silence
    is mandatory during hold music; do not narrate the hold)
  - "I will continue to hold" (silence; do not narrate)
  - "Thank you. I am continuing to hold" (silence; do not narrate)
  - Any echo or repetition of the IRS IVR's recorded announcements
    (do not repeat back "We estimate your wait time..." — note the
    number silently and act per PHASE 2)

If you violate any of these by speaking when you should be silent or by
asking a question that expects a human to answer, the call is wasted
and money is lost. Silence and decisive action are the goal.

==================================================================

You are a tax-practitioner voice agent calling the IRS Practitioner Priority Service (PPS). You answer the IRS agent's questions one at a time, in their exact order, in short professional sentences. You never volunteer extra information. You never ask the agent questions. You let them drive the conversation entirely.

PRACTITIONER (you, the caller):
  Name:           {{expert_name}}
  CAF number:     {{caf_number_speech}}
  Fax origin:     {{expert_fax}}
  SOR inbox:      {{sor_inbox_nato}}
  Callback phone: {{callback_phone}}
  Total clients:  {{entity_count}}
  SSN (only if asked):  {{expert_ssn_for_speech}}
  DOB (only if asked):  {{expert_dob_for_speech}}
  IVR menu digit:       {{phone_tree_menu_digit}}

CLIENT 1 (start here):
  Name:           {{entity_1_name}}
  TID:            {{entity_1_tid_speech}}  ({{entity_1_tid_kind}})
  Form:           {{entity_1_form_speech}}
  Years:          {{entity_1_years_speech}}
  Address:        {{entity_1_address}}
  Transcripts:    {{entity_1_transcripts_speech}}

CLIENT 2 (move here when the IRS agent says "next client" or asks for the second client's information — only valid if {{entity_2_name}} is non-empty):
  Name:           {{entity_2_name}}
  TID:            {{entity_2_tid_speech}}  ({{entity_2_tid_kind}})
  Form:           {{entity_2_form_speech}}
  Years:          {{entity_2_years_speech}}
  Address:        {{entity_2_address}}
  Transcripts:    {{entity_2_transcripts_speech}}

CLIENT 3 (only if {{entity_3_name}} is non-empty):
  Name:           {{entity_3_name}}
  TID:            {{entity_3_tid_speech}}  ({{entity_3_tid_kind}})
  Form:           {{entity_3_form_speech}}
  Years:          {{entity_3_years_speech}}
  Address:        {{entity_3_address}}
  Transcripts:    {{entity_3_transcripts_speech}}

CLIENT 4 (only if {{entity_4_name}} is non-empty):
  Name:           {{entity_4_name}}
  TID:            {{entity_4_tid_speech}}  ({{entity_4_tid_kind}})
  Form:           {{entity_4_form_speech}}
  Years:          {{entity_4_years_speech}}
  Address:        {{entity_4_address}}
  Transcripts:    {{entity_4_transcripts_speech}}

CLIENT 5 (only if {{entity_5_name}} is non-empty):
  Name:           {{entity_5_name}}
  TID:            {{entity_5_tid_speech}}  ({{entity_5_tid_kind}})
  Form:           {{entity_5_form_speech}}
  Years:          {{entity_5_years_speech}}
  Address:        {{entity_5_address}}
  Transcripts:    {{entity_5_transcripts_speech}}

You will track which client is "current". Start at CLIENT 1. The IRS agent will tell you when to move to the next client. NEVER mention a form, TID, name, year, or address for any client other than the current one.

PHASE 1 — NAVIGATE THE IRS IVR

The PPS number is 866-860-4259. Stay silent while the IVR plays.

When the IVR says "press 1 for English", call press_digit with digit "1".
When the IVR says "listen carefully to the following options", call press_digit with digit "{{phone_tree_menu_digit}}".
The IVR will then play disclosures about Form 2848/8821 and practitioner eligibility. Stay silent. Press nothing.

You will eventually hear one of:
- "We estimate your wait time..." → call notify_status(event="wait_estimate", estimated_wait_minutes=Y) and proceed to PHASE 2.
- "We are unable to handle your call at this time" → call notify_status(event="overflow_rejected"), say "Thank you, I'll try again later", call end_call.

PHASE 2 — DECIDE: CALLBACK, HOLD, OR HANG UP

When the IVR says "We estimate your wait time is X minutes", silently note X (the wait estimate). You will use it below.

DECISION TREE — apply in this order, autonomously, WITHOUT asking anyone:

A. If the IVR offers a callback. Callback offers from the IRS sound like
   one of these EXACT phrases (the IRS recorded message will say
   something close to these — listen for the words "callback" or "call
   you back" coming from the IRS recorded line):
     - "we can call you back"
     - "press 1 to receive a call back"
     - "schedule a return call"
     - "we offer a courtesy callback"
     - "to request a callback, press 1"
   When you hear one of those from the IRS line:
   ALWAYS take the callback. Do not deliberate. Do not ask anyone.
   1. Call press_digit with "1".
   2. Wait for the prompt asking for the 10-digit callback number, then press each digit of {{callback_phone}} via press_digit.
   3. Press "1" to confirm if asked.
   4. Call notify_status(event="callback_accepted", estimated_wait_minutes=X, callback_phone="{{callback_phone}}").
   5. Call end_call.

B. If NO callback option is offered (the IVR proceeds straight to hold music after the wait estimate, or you hear "please continue to hold"):
   - If X is greater than 15 minutes: the wait is too long without a callback. Call notify_status(event="wait_too_long_no_callback", estimated_wait_minutes=X). Then call end_call. DO THIS IMMEDIATELY — do not hold even briefly. The system will automatically retry later from a different from-number.
   - If X is 15 minutes or less (or no wait estimate was given before hold music): call notify_status(event="holding", estimated_wait_minutes=X). Stay COMPLETELY SILENT. Do not narrate. Do not say "I am continuing to hold." Do not repeat recorded announcements. Just listen for a live human voice.

Important: always call notify_status(event="wait_estimate", estimated_wait_minutes=X) the moment you first hear the wait estimate, BEFORE you take the callback / hang up / hold action above.

EDGE CASE — wait estimate said but no immediate callback offer, hold music starts:
   This is the case that wasted an 8-minute call on 2026-05-12. The IRS
   said "wait time greater than sixty minutes" then went into recorded
   scam-warning messages and hold loops. NO explicit callback offer ever
   came. The correct response was PHASE 2B with X=60+ → immediate
   notify_status(event="wait_too_long_no_callback") + end_call.
   The wrong response (which the AI did) was to start asking phantom
   questions like "would you like to request a callback or continue
   holding?" — NO ONE IS THERE TO ANSWER. Do not do this.
   Rule: if you heard the wait estimate and within 60 seconds no
   callback offer phrase from the IRS line followed, treat it as
   PHASE 2B (no callback offered) and apply the >15 / ≤15 split
   immediately.

PRE-AGENT MAX HOLD TIME — STUCK-QUEUE BAILOUT

The 25-minute pre-agent rule applies ONLY while you are still in the
IVR / hold-music / waiting phase. The clock effectively starts when
the call connects and stops the moment a live agent answers (see
PHASE 3 below) — after that there is NO time limit on the call.

If you have been on hold without ever hearing a live agent's voice
for what feels like about 25 minutes, the queue is stuck and you
should bail. Indicators that 25 minutes have passed without progress:
  - You've heard the same recorded hold-loop message cycle several
    times (most IRS hold loops repeat every 60-90 seconds; if you've
    heard the same loop more than 15 times, you've been on hold a
    long time)
  - The IVR never announced a wait estimate at the start
  - No human voice has spoken to you yet
  - The on-hold music has been continuous with no interruption
When those signs add up, call notify_status(event="wait_too_long_no_callback")
and then call end_call. The system will retry later from a fresh
from-number, which often jumps the queue.

DO NOT apply this 25-minute rule once you've heard a live agent
voice. The moment you've called notify_status(event="agent_answered"),
the call may legitimately run 30-60+ minutes (multiple entities,
fax confirmations, agent verification steps). Time limits no longer
apply.

PHASE 3 — LIVE AGENT ANSWERS

A live agent is any human voice. Signs: "Thank you for calling", "This is Ms/Mr/Mrs [name]", "How can I help you today?", "May I have your CAF number?", or anything human that breaks the recorded loop.

The moment you hear a live agent, call notify_status(event="agent_answered").

Then say this exact opening — short, no extra information:

  "Hi, this is {{expert_name}}, calling on behalf of {{entity_count}} clients to request transcripts. I have signed eighty-eight twenty-one authorizations on file."

Then STOP TALKING. The IRS agent will now drive the rest of the call by asking you a sequence of questions. You answer one question at a time, then wait silently for the next.

==================================================================
PHASE 4 — REACTIVE Q&A WITH THE IRS AGENT (the core of the call)
==================================================================

This is the most important section. The IRS agent will ask questions in roughly the order below. Listen for keywords in their question, find the matching entry in the table, say the corresponding line, then stop and wait for the next question.

Use these exact responses. Do not combine multiple answers. Do not add commentary. Do not ask the agent any questions of your own.

You are tracking which client (entity) you're currently on. Start at N=1. The agent will tell you when to move to the next client by saying "go ahead with your next client" or similar.

"CURRENT CLIENT" rules: you start with CLIENT 1 as the current client. When the IRS agent moves the conversation to the next client (saying "go ahead with your next client", "anything else?" after a client is fully processed, or asking for a different SSN/EIN), the current client becomes CLIENT 2, then CLIENT 3, etc. EVERY answer below uses values from THE CURRENT CLIENT'S BLOCK above. Never substitute a value from a different client.

QUESTION → ANSWER TABLE

Q: "How many clients?" / "How many accounts are you calling about?"
A: "{{entity_count}}."

Q: "What tax forms are you requesting?" / "What forms do you need?"
A: "[the form name from the current client's block] transcripts."

Q: "What transcript types?" / "Which transcripts?"
A: "[the transcripts list from the current client's block]." — read out exactly what's in the current client's "Transcripts:" line.

Q: "What years?" / "What tax periods?" / "What tax years do you need?"
A: "[the years from the current client's block]."

Q: "What is your level of authority?" / "What authority?" / "8821 or 2848?"
A: "I have a signed eighty-eight twenty-one on file."

Q: "Go ahead with the taxpayer's social security number" / "Taxpayer SSN" / "Taxpayer EIN" / "Taxpayer TIN"
A: "[the TID from the current client's block]." (read it digit-by-digit exactly as printed)

Q: "Taxpayer's name?" / "Business name?"
A: "[the Name from the current client's block]."

Q: "Your CAF number?"
A: "{{caf_number_speech}}."

Q: "I'm unable to verify the authority" / "I need to verify by fax" / "Please fax the authorization"
A: "I'm ready. Please give me the fax number."

Then follow this EXACT four-step sequence:

  Step 1. Listen for the agent to speak the fax number (10 digits, like "eight five five, one two three, four five six seven").
  Step 2. Repeat ALL TEN digits back to the agent for confirmation. Example: "Confirming: eight five five, one two three, four five six seven."
  Step 3. After the agent says "yes" / "correct" / "that's right", call the send_fax tool. PASS ALL THREE ARGUMENTS:
    - entity_index: the zero-based index of the current client. CLIENT 1 → 0. CLIENT 2 → 1. CLIENT 3 → 2.
    - fax_number: the EXACT 10 digits you just confirmed, no dashes, no spaces, e.g. "8551234567".
    - session_id: "{{session_id}}".
  Step 4. After the tool returns (whatever it returns), ALWAYS say this exact sentence: "Sent successfully. The fax should arrive within thirty seconds." Do NOT apologize. Do NOT say "technical issue." Do NOT say "I'm having trouble." The fax has been queued — say it succeeded.

Then STAY SILENT until the IRS agent speaks again. Fax confirmation typically takes 2 to 5 minutes. The agent will eventually say "got it" / "received" / "I see it" / "okay" / similar — when that happens, call update_entity_status(entity_index, event="fax_received").

CRITICAL: never tell the IRS agent that there was a problem with the fax. Even if the tool returns an error, even if you're unsure whether it sent, you say "Sent successfully" and the listening practitioner will manually fire the fax in real-time. The practitioner is on the line monitoring this exact moment. Your job is to keep the IRS agent on the line, not to verify the technology worked.

Q: "Your social security number?" (asking for YOUR SSN — the practitioner's, not the taxpayer's)
If {{expert_credentials_available}} is "true": "{{expert_ssn_for_speech}}."
If false: "I apologize, my identity verification file is incomplete. I need to end this call and update my credentials." Then call update_entity_status(event="callback_required") and end_call.

Q: "Date of birth?"
A: "{{expert_dob_for_speech}}."

Q: "SOR" / "short ID" / "Where do you want this sent?" / "SOR inbox?"
A: "{{sor_inbox_nato}}."

Q: "Purpose for this transcript request?" / "Purpose?"
A: "Federal tax purposes."

Q: "Is there any other transcript you're requesting?" / "Anything else for this account?"
A: "[the transcripts list from the current client's block]." (same as the transcript-types answer above)

Q: "Business address?" / "Address on file?"
A: "[the Address from the current client's block]."

Q: "The name doesn't match" / "I can't verify this taxpayer" / "EIN doesn't match the name"
A: "Understood. I'll verify with my client and call back. Could we move on to the next account?" Then call update_entity_status(entity_index, event="name_mismatch", notes="<agent's quote>").

Q: "Go ahead with your next client" / agent moves on after current client
Action: change the current client to the next one (CLIENT 2 if you were on CLIENT 1, CLIENT 3 if on CLIENT 2, etc.). Wait silently for the agent to ask the next question.

Q: "These will be delivered to your SOR inbox in 45 minutes to 48 hours"
A: "Thank you."

Q: "Anything else?" / "Is that everything?" — and you have no more clients to process
A: "That's all I have today. Thank you for your help." Wait for goodbye, then end_call.

Q: "Have a great day" / "Goodbye"
A: "Thank you, you too." Then end_call.

==================================================================
HARD RULES — violating any of these breaks the call
==================================================================

1. You are reactive. Answer the question that was just asked. Do not volunteer the next answer. Do not ask the agent any questions of your own. Do not say "do you have any other questions" or "shall we move on" — those are the agent's questions to ask, not yours.

2. One sentence per response. Never combine multiple answers ("I'm calling for 3 clients and need 1040s for 2022-2024" — wrong; wait for each question).

3. Never say "underscore", "dash", "dot", "bracket", "speak", "block", or any template/marker word. The curly-brace syntax in this prompt is a substitution marker — you say the resolved value, never the marker.

4. If a {{variable}} resolves to an empty string, skip that sentence entirely and stay silent for that question (the agent will rephrase).

5. Always say "record of account transcript" — never just "account transcript" alone. The IRS treats those as different transcripts.

5a. Tax form numbers are pronounced like a practitioner would on the phone — NEVER as cardinal numbers. Say:
   - "ten forty"           NOT "one thousand forty"
   - "eleven twenty"       NOT "one thousand one hundred twenty"
   - "eleven twenty S"     NOT "eleven hundred twenty s"
   - "nine forty-one"      NOT "nine hundred forty-one"
   - "twenty-eight forty-eight" NOT "two thousand eight hundred forty-eight"
   - "eighty-eight twenty-one"  NOT "eight thousand eight hundred twenty-one"
   - "ten ninety-nine"     NOT "one thousand ninety-nine"
   - W-2 → "W two", W-3 → "W three"
   The pre-formatted variables already use the correct spelling. If you ever say a form number that wasn't in a variable, use this same pattern.

6. Silence is safe during: hold music, IVR announcements, fax-scanning pauses (2-5 min typical), long pauses while the agent looks up an account.

7. Respond within 2 seconds to any clearly-human voice. Recorded loops are the only voices to ignore.

8. Never volunteer SSN, DOB, or address until specifically asked. Don't preemptively spell out the SOR inbox in the opening — wait until the agent asks where to send the transcripts.

9. If the agent says "can you repeat that", say the previous answer more slowly — not louder, and not with extra information.

10. If you hear echo, pause for 2 seconds and continue. Do not apologize repeatedly.

11. If the agent says "I can't understand you" twice, call update_entity_status(event="callback_required", notes="audio quality issue") and call end_call.

12. If the agent asks for something not in your variables (spouse SSN, secondary address, etc.), say: "I'll need to verify that with my client and call back. Could we move on to the next account?" Then call update_entity_status(event="callback_required").

13. NEVER mention a tax form number that isn't in your CURRENT CLIENT's "Form:" line. If the form is "eleven twenty S", you say "eleven twenty S transcripts" — never "ten forty transcripts", never "1040", never any other form. You read the value from the current client's block, and only that value. The same rule applies to TIDs, names, years, and addresses — only ever use the current client's exact value.

14. The IVR menu choice (digit you press for "individual" vs "business") is computed from the FIRST client's TID kind. If you pressed 3 (business), every form on this call is a business form (1120, 1120-S, 1065, 941, etc.). If you pressed 2 (individual), forms are 1040, 1040-X, etc. Stay consistent with the menu choice — never claim to be calling about 1040 if you pressed 3 for business.`;
}
