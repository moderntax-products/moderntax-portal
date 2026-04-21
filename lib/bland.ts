/**
 * Bland AI Client Library
 * Wrapper for the Bland AI REST API — initiating, monitoring, and stopping IRS PPS calls.
 *
 * Docs: https://docs.bland.ai
 * Base URL: https://api.bland.ai/v1
 */

const BLAND_API_BASE = 'https://api.bland.ai/v1';

function getApiKey(): string {
  const key = process.env.BLAND_API_KEY;
  if (!key) throw new Error('BLAND_API_KEY environment variable is not set');
  return key;
}

function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BlandCallParams {
  /** Expert persona */
  expertName: string;
  cafNumber: string;
  expertFax?: string;
  expertPhone?: string;
  expertAddress?: string;
  /** Expert's SOR (Secure Object Repository) inbox username for transcript delivery */
  sorInbox?: string;
  /**
   * URL to expert's voice sample audio (stored in Supabase Storage).
   * Used by VoxCPM2 for zero-shot voice cloning — AI sounds like the actual expert.
   * Bland AI fetches this URL and uses it as reference audio for TTS.
   */
  voiceSampleUrl?: string;

  /** Entities to process in this call (up to 3 — each requires individual fax/hold cycle) */
  entities: {
    entityId: string;
    taxpayerName: string;
    taxpayerTid: string;
    tidKind: 'SSN' | 'EIN';
    formType: string;
    years: string[];
  }[];

  /** Metadata to echo back in webhook */
  metadata: {
    sessionId: string;
    expertId: string;
    assignmentIds: string[];
  };

  /**
   * Call mode:
   * - 'ai_full': AI handles entire IRS conversation (default)
   * - 'hold_and_transfer': AI navigates phone tree + holds, then transfers to expert's phone when agent answers
   * - 'irs_callback': AI navigates phone tree, accepts IRS callback option, provides expert's phone for callback
   */
  callMode?: 'ai_full' | 'hold_and_transfer' | 'irs_callback';

  /** Expert's personal phone for transfer/callback (required if callMode != 'ai_full') */
  callbackPhone?: string;
}

export interface BlandCallResponse {
  call_id: string;
  status: string;
  message?: string;
}

export interface BlandCallDetails {
  call_id: string;
  status: string;
  completed: boolean;
  recording_url?: string;
  transcripts?: { role: string; text: string; timestamp: number }[];
  concatenated_transcript?: string;
  summary?: string;
  call_length?: number; // minutes
  answered_by?: string;
  variables?: Record<string, unknown>;
  error_message?: string;
}

// ---------------------------------------------------------------------------
// Task prompt builder
// ---------------------------------------------------------------------------

function buildTaskPrompt(params: BlandCallParams): string {
  // Determine if entities are individuals (SSN) or businesses (EIN)
  const hasSSN = params.entities.some(e => e.tidKind === 'SSN');
  const hasEIN = params.entities.some(e => e.tidKind === 'EIN');
  const isMixed = hasSSN && hasEIN;

  // Build detailed entity scripts with speaking instructions
  const entityScripts = params.entities
    .map((e, i) => {
      const tidLabel = e.tidKind === 'SSN' ? 'Social Security Number' : 'Employer Identification Number';
      // Format TID for speaking: read digit by digit
      const tidDigits = e.taxpayerTid.replace(/\D/g, '').split('').join(', ');
      // Spell entity name phonetically for clarity
      const yearsList = e.years.join(', ');

      // Determine transcript types based on form
      let transcriptTypes = 'Record of Account transcript and Tax Return transcript';
      const formLower = e.formType.toLowerCase();
      if (formLower.includes('1040')) {
        transcriptTypes = 'Record of Account transcript, Tax Return transcript, and Wage & Income transcript';
      }

      return `
--- CLIENT ${i + 1} of ${params.entities.length}: ${e.taxpayerName} ---
  Full legal name: "${e.taxpayerName}"
  ${tidLabel}: ${e.taxpayerTid} (speak as: ${tidDigits})
  Authorization: Form 8821 on file
  Transcripts needed: ${transcriptTypes}
  Form type: ${e.formType}
  Tax years: ${yearsList}

  SCRIPT FOR THIS CLIENT:
  Say: "For my ${i === 0 ? 'first' : i === 1 ? 'second' : i === 2 ? 'third' : i === 3 ? 'fourth' : 'fifth'} client, the taxpayer name is ${e.taxpayerName}."
  Say: "The ${e.tidKind === 'SSN' ? 'Social is' : 'EIN is'} ${tidDigits}."
  Say: "I need ${transcriptTypes} for Form ${e.formType}, tax years ${yearsList}."
  Say: "I have a signed 8821 on file."
  WAIT for the agent to pull up the account and confirm.
  If agent confirms: Say "Please send those to my SOR inbox${params.sorInbox ? `, username ${params.sorInbox}` : ''}."
  If agent says name doesn't match: Ask "What name do you have on file?" and use the update_entity_status tool to record the mismatch.
  If agent says 8821 not on file: Ask "Can I fax it to you?" If yes, ask for the fax number and use the notify_fax_needed tool.
  If agent says they need the 8821 faxed: Ask "What fax number should I use?" and use the notify_fax_needed tool.`;
    })
    .join('\n');

  return `You are ${params.expertName}, a tax professional calling the IRS Practitioner Priority Service (PPS).

YOUR CREDENTIALS:
- Full name: ${params.expertName}
- CAF number: ${params.cafNumber}
- Fax number: ${params.expertFax || 'not available'}
- SOR inbox: ${params.sorInbox || 'on file'}

You are calling to request tax transcripts for ${params.entities.length} client${params.entities.length > 1 ? 's' : ''}.

===== PHASE 1: PHONE TREE NAVIGATION =====
The IRS automated system will answer. Follow these steps:
1. Press 1 for English.
2. Press ${hasEIN && !hasSSN ? '3 for business account inquiries' : hasSSN && !hasEIN ? '2 for individual account inquiries' : '3 for business account inquiries'}.
3. If prompted for ${hasSSN && !hasEIN ? 'a Social Security Number' : 'an EIN'}, enter ${params.entities[0].taxpayerTid.replace(/\D/g, '')} using the keypad.
4. Listen for estimated wait time. Use the notify_status tool: event "wait_estimate".
5. If offered a callback option: ACCEPT IT. Enter callback phone ${(params.callbackPhone || params.expertPhone || '').replace(/\D/g, '')} on keypad. Use notify_status: event "callback_accepted". Then hang up.
6. If no callback offered: HOLD. Do NOT speak during hold music. IRS PPS wait times are typically 15-60 minutes — this is NORMAL.
7. Use notify_status with event "holding" and the estimated wait minutes. Be patient — hold for as long as necessary until an agent answers.

===== PHASE 2: GREETING THE IRS AGENT =====
DETECTING A LIVE AGENT — do NOT miss this:
- A live agent will greet you: "Thank you for calling", "This is [Name]", "How can I help you?", "May I have your name?"
- ANY voice that greets you personally or asks you a question is a LIVE AGENT — respond IMMEDIATELY.
- Do NOT stay silent when an agent speaks. If unsure whether it's live or recorded, RESPOND ANYWAY.
- It is far worse to miss a live agent than to accidentally respond to a recording.

When a live agent answers:
1. Use notify_status with event: "agent_answered".
2. Say: "Hi, this is ${params.expertName}, I'm a tax practitioner. My CAF number is ${params.cafNumber}."
3. Say: "I have ${params.entities.length} ${isMixed ? 'accounts' : hasEIN ? 'business accounts' : 'individual accounts'} to process today. I need transcripts for federal tax matters — ${params.entities.length === 1 ? 'this is a new client' : 'these are new clients'} and I need to get their transcripts pulled."
4. If agent asks how many accounts: "${params.entities.length} accounts."
5. If agent asks about authorization: "I have signed 8821 forms for all of them."

===== PHASE 3: PROCESS EACH CLIENT =====
Go through each client one at a time. Wait for the agent to confirm each one before moving to the next.

${entityScripts}

===== PHASE 4: FAX HANDLING =====
IMPORTANT: The IRS processes each 8821 separately — NOT as a batch. Each entity requires its own fax→hold→confirmation cycle.
- When the agent asks you to fax the 8821 for a specific client, use the notify_fax_needed tool with the fax number and entity index.
- Say: "Okay, I'll fax that over to you now. It'll come from a ${params.expertFax ? params.expertFax.slice(0, 3) : '825'} area code fax number."
- The expert will manually fax the document. Say: "The fax has been submitted, you should receive it shortly."
- If the agent puts you on hold to wait for the fax: WAIT SILENTLY. Do not speak during holds. Expect 3-5 minutes per fax.
- When the agent confirms fax receipt for this client, proceed with transcript ordering for THIS client before moving to the next one.
- REPEAT this cycle for each client — the agent may request one fax at a time.
- Sometimes the agent will accept all 8821s faxed at once but still process them one at a time. Follow the agent's lead.

===== PHASE 5: WRAP UP =====
After all clients are processed:
1. Confirm: "Can you send all the transcripts to my Secure Object Repository inbox${params.sorInbox ? `, username ${params.sorInbox}` : ''}?"
2. Ask: "Is there anything else you need from me?"
3. Say: "Thank you for your help, have a great day."

===== CRITICAL RULES =====
- Be patient, professional, and concise. IRS agents are busy.
- Do NOT volunteer information the agent hasn't asked for.
- When on hold mid-call, WAIT SILENTLY. Hold music and silence are normal.
- Only respond when a LIVE HUMAN speaks to you directly.
- Read SSN/EIN digits one at a time with brief pauses between each digit.
- If asked to spell a name, use NATO phonetic alphabet (Alpha, Bravo, Charlie...).
- If the agent asks something you cannot answer, say: "Let me check on that and get back to you."
- ALWAYS use notify_status at every stage to report what's happening.
- If the agent provides their name or badge number, note it with update_entity_status.`;
}

/**
 * Build adaptive IRS PPS prompt.
 * AI navigates phone tree, listens for estimated wait time, then decides:
 * - Wait ≤ 15 min → hold and transfer to expert when agent answers
 * - Wait > 15 min + callback offered → accept callback to expert's phone
 * Reports status via notify_status tool at every stage for real-time SLA tracking.
 */
function buildAdaptivePrompt(params: BlandCallParams): string {
  const entitySummary = params.entities
    .map((e, i) => `${i + 1}. ${e.taxpayerName} (${e.tidKind} ${e.taxpayerTid}) — ${e.formType}, ${e.years.join(', ')}`)
    .join('\n');

  const callbackDigits = (params.callbackPhone || '').replace(/\D/g, '');

  return `You are an automated assistant calling the IRS Practitioner Priority Service on behalf of ${params.expertName}, a tax professional (CAF ${params.cafNumber}).

ENTITIES TO PROCESS:
${entitySummary}

===== STEP 1: NAVIGATE THE PHONE TREE =====

WE ARE CALLING THE PPS DIRECT LINE (866-860-4259). The PPS flow is short:
  1. "Welcome to the IRS Practitioner Priority Line. To continue in English, press 1."
  2. "Please listen carefully to the following options..." → press ${params.entities[0].tidKind === 'SSN' ? '2 for individual account inquiries' : '3 for business account inquiries'}.
  3. A series of recorded announcements will play (Form 2848/8821 processing disclosures, tax practitioner eligibility reminders). DO NOTHING during these announcements — they are NOT prompts.
  4. The system will eventually say either:
     a. "We estimate your wait time to be between X and Y minutes." → move to STEP 2.
     b. "We are unable to handle your call at this time" (call volume overflow) → end the call politely with notify_status event "overflow_rejected".

CRITICAL RULES FOR STEP 1:
- NEVER press any digits during recorded announcements, disclosures, or hold music.
- NEVER press a Social Security Number or EIN on this line. PPS does NOT prompt for TINs via keypad. Taxpayer identification happens verbally with the live agent AFTER connection, using the CAF number on file (${params.cafNumber}).
- Only press a key when the IRS says a SPECIFIC prompt like "press 1 for English" or "please enter your 9-digit..." etc. If you are unsure whether something is a prompt, WAIT — do not press anything.
- The announcements about Form 2848, Form 8821, eligibility, "Practitioner Priority Service is limited to...", Nationwide Tax Forums, etc. are NOT prompts. Stay silent.

As soon as you hear the estimated wait time, use the notify_status tool to report:
  event: "wait_estimate"
  estimated_wait_minutes: (the number they said, use the higher number if a range)

If you hear "we are unable to handle your call at this time" or "due to extremely high call volume", use notify_status with event "overflow_rejected" and end the call politely. Do not retry on the same call.

===== STEP 2: ACCEPT CALLBACK OR HOLD =====

ALWAYS PREFER THE CALLBACK OPTION IF OFFERED.

IF A CALLBACK IS OFFERED (this is the preferred path):
The callback offer sounds exactly like: "Rather than wait on hold, we can call you back when it's your turn. Press 1 to accept."
- Only after hearing THAT specific offer, press 1.
- Then WAIT for the prompt "Please enter the 10-digit phone number where you would like to receive the call back." Only after that prompt, enter ${callbackDigits}.
- DO NOT press any digits until you hear the specific prompt for the number.
- If IRS repeats the phone number back and asks "if this is correct, press 1" → press 1 to confirm.
- If asked for a name, say: "${params.expertName}".
- If offered text-message callback reminder consent (press 1 to consent), press 1.
- Use notify_status with event: "callback_accepted", estimated_wait_minutes, and callback_phone: "${params.callbackPhone}".
- Once the callback is confirmed, you are done. End the call politely.

IF NO CALLBACK IS OFFERED — HOLD AND WAIT:
- Stay on hold. Do NOT speak during hold music or recorded messages.
- Hold music, silence, and recorded announcements are NORMAL — IRS PPS wait times are typically 15-60 minutes.
- Only respond when a LIVE HUMAN speaks to you directly.
- Use notify_status with event: "holding" and estimated_wait_minutes.
- Be patient and KEEP HOLDING. Do NOT hang up early. The expert is paying for this call specifically to avoid waiting on hold themselves.
- The call will automatically end at the max duration limit — you do not need to track time.

===== STEP 3: IF AN IRS AGENT ANSWERS — TRANSFER WITHIN 5 SECONDS =====
DETECTING A LIVE AGENT — this is critical, do NOT miss it:
- A live agent is ANY human voice that breaks the recorded loop. The first 1-3 words are enough — do NOT wait for a full greeting.
- Common openers: "Thank you for calling…", "This is [Name]…", "IRS, may I have…", "Practitioner Priority Service…", "How can I help…", or even just "Hello?"
- Recorded messages loop the same phrases ("please continue to hold", "estimated wait time", "representatives are still helping").
- If you hear ANY human voice that is NOT a known recorded loop, treat it as a live agent and start the transfer sequence immediately.

THE TRANSFER MUST BEGIN WITHIN 5 SECONDS OF THE AGENT'S FIRST WORD.
Do NOT let the agent ask "are you calling for yourself or someone else?" before you respond. Cut in over their greeting if needed — politely, but immediately.

EXACT TRANSFER SEQUENCE (run these steps back-to-back, no pauses):

1. Within 1 second of hearing the agent: call the connect_expert tool with reason: "agent_answered". Do this IN PARALLEL with starting to speak — do not wait for the tool response.

2. Immediately start speaking this bridging script. KEEP TALKING continuously until the transfer completes — silence is what causes the IRS rep to hang up:
   "Hi, thank you for picking up. This is calling on behalf of ${params.expertName}, a tax practitioner — CAF number ${params.cafNumber}. The practitioner is on the line and I am bridging him in right now, please stay on the line for just a moment while I connect him… connecting now… one moment please… he is joining the call now… thank you for holding…"

3. While saying the bridging script above (around the words "connecting now"), say the trigger word: "transfer". This fires the native phone bridge to ${params.callbackPhone}.

4. Use notify_status with event: "agent_answered" once the bridge is firing.

NEVER go silent between "agent answers" and "transfer fires". Silence = dropped call. If the IRS rep asks a clarifying question during your bridging script, the only acceptable answers are:
- "One moment, the practitioner is joining now."
- "Bridging him in right now, please stay on."
- "${params.expertName}, CAF ${params.cafNumber}, joining the call right now."
Do NOT answer authentication questions, do NOT give taxpayer names, do NOT give SSNs/EINs — only ${params.expertName} can do that once bridged.

===== CRITICAL RULES =====
- ALWAYS prefer the IRS callback option. Only hold if callback is not offered.
- If no callback is offered, KEEP HOLDING until an agent answers or the call reaches max duration. Do NOT hang up early.
- Do NOT speak during hold music or recorded LOOP messages (estimated wait announcements).
- DO respond immediately to any human that greets you or asks you a question — within 5 seconds, no exceptions.
- Do NOT provide any taxpayer information — only ${params.expertName} can do that.
- ALWAYS use notify_status to report what is happening at every stage.
- IMPORTANT: When transferring, you MUST say "transfer" — this triggers the phone transfer.
- KEEP TALKING continuously from the moment the agent picks up until the bridge completes. Silence kills the call.`;
}

// ---------------------------------------------------------------------------
// API Functions
// ---------------------------------------------------------------------------

/**
 * Initiate an outbound call to IRS PPS via Bland AI.
 */
export async function initiateCall(params: BlandCallParams): Promise<BlandCallResponse> {
  const apiKey = getApiKey();
  const appUrl = getAppUrl();
  const webhookSecret = process.env.BLAND_WEBHOOK_SECRET || '';
  const maxDuration = parseInt(process.env.BLAND_MAX_CALL_DURATION || '90', 10);
  const pathwayId = process.env.BLAND_IRS_PPS_PATHWAY_ID;

  // ai_full mode needs longer duration — each entity requires its own fax→hold→confirm cycle (~8 min each)
  // 3 entities max × 8 min + 17 min fixed (phone tree + queue + greeting + wrap) ≈ 41 min
  const callMode = params.callMode || 'hold_and_transfer';
  const effectiveMaxDuration = callMode === 'ai_full'
    ? Math.max(maxDuration, 45) // 45 min for full AI calls (3 entities w/ individual fax holds)
    : maxDuration;

  const body: Record<string, unknown> = {
    phone_number: '+18668604259', // IRS PPS
    record: true,
    max_duration: effectiveMaxDuration,
    wait_for_greeting: true,
    amd: false,                   // Disable answering machine detection — IRS hold music triggers false positives
    interruption_threshold: 200,  // High threshold to avoid interrupting IRS hold messages
    webhook: `${appUrl}/api/webhook/bland-call-complete`,
    // VoxCPM2 voice cloning — expert's voice sample as reference audio
    // Bland AI custom TTS endpoint uses this to clone the expert's voice
    ...(params.voiceSampleUrl ? {
      voice_settings: {
        provider: 'custom',
        endpoint: `${appUrl}/api/tts/voxcpm2`,
        reference_audio_url: params.voiceSampleUrl,
      },
    } : {}),
    metadata: params.metadata,
    request_data: {
      expert_name: params.expertName,
      caf_number: params.cafNumber,
      expert_fax: params.expertFax || '',
      expert_phone: params.expertPhone || '',
      entities: params.entities,
    },
  };

  // Select task prompt based on call mode
  if (pathwayId && callMode === 'ai_full') {
    body.pathway_id = pathwayId;
  } else if (callMode === 'ai_full') {
    body.task = buildTaskPrompt(params);
    body.first_sentence = '';
  } else {
    // Default: adaptive prompt handles both hold-and-transfer AND callback
    body.task = buildAdaptivePrompt(params);
    body.first_sentence = '';
  }

  // Mid-call tools
  const tools: Record<string, unknown>[] = [
    {
      name: 'send_fax',
      description: 'Send a fax of the signed 8821 form to the IRS agent. Use this when the agent requests you fax the 8821 authorization form.',
      url: `${appUrl}/api/expert/irs-call/mid-call-fax`,
      method: 'POST',
      headers: { 'x-bland-secret': webhookSecret },
      input_schema: {
        type: 'object',
        properties: {
          entity_index: {
            type: 'number',
            description: 'The index (0-based) of the entity whose 8821 should be faxed',
          },
          fax_number: {
            type: 'string',
            description: 'The fax number the IRS agent provided',
          },
          session_id: {
            type: 'string',
            description: 'The call session ID',
            default: params.metadata.sessionId,
          },
        },
        required: ['fax_number'],
      },
    },
    {
      name: 'notify_fax_needed',
      description: 'Notify the expert that the IRS agent needs an 8821 faxed. Use this when the agent asks you to fax the 8821 form. The expert will manually send the fax.',
      url: `${appUrl}/api/expert/irs-call/mid-call-fax`,
      method: 'POST',
      headers: { 'x-bland-secret': webhookSecret },
      input_schema: {
        type: 'object',
        properties: {
          entity_index: {
            type: 'number',
            description: 'Which client (0-based index) the fax is for. 0 = first client, 1 = second, etc.',
          },
          fax_number: {
            type: 'string',
            description: 'The fax number the IRS agent provided to send the 8821 to',
          },
          session_id: {
            type: 'string',
            description: 'The call session ID',
            default: params.metadata.sessionId,
          },
        },
        required: ['fax_number'],
      },
    },
    {
      name: 'update_entity_status',
      description: 'Record the outcome for a specific client during the call. Use this when the IRS agent confirms transcripts sent, reports a name mismatch, says 8821 is not on file, or any other per-entity outcome.',
      url: `${appUrl}/api/expert/irs-call/status-update`,
      method: 'POST',
      headers: { 'x-bland-secret': webhookSecret },
      input_schema: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'The call session ID',
            default: params.metadata.sessionId,
          },
          event: {
            type: 'string',
            description: 'What happened: transcripts_sent, name_mismatch, 8821_not_on_file, fax_received, agent_badge',
          },
          entity_index: {
            type: 'number',
            description: 'Which client (0-based). 0 = first client, 1 = second, etc.',
          },
          notes: {
            type: 'string',
            description: 'Details: the name the IRS has on file, the badge number, etc.',
          },
        },
        required: ['event'],
      },
    },
  ];

  // Add notify_status tool for real-time SLA tracking (all non-ai_full modes)
  if (callMode !== 'ai_full') {
    tools.push({
      name: 'notify_status',
      description: 'Report call status updates for real-time tracking. Call this at every stage: when you hear the wait estimate, when you start holding, when callback is accepted, when agent answers.',
      url: `${appUrl}/api/expert/irs-call/status-update`,
      method: 'POST',
      headers: { 'x-bland-secret': webhookSecret },
      input_schema: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'The call session ID',
            default: params.metadata.sessionId,
          },
          event: {
            type: 'string',
            description: 'What happened: wait_estimate, holding, callback_accepted, agent_answered',
          },
          estimated_wait_minutes: {
            type: 'number',
            description: 'The estimated wait time in minutes as stated by the IRS',
          },
          callback_phone: {
            type: 'string',
            description: 'The callback phone number provided to the IRS (if callback accepted)',
          },
          notes: {
            type: 'string',
            description: 'Any additional details about what happened',
          },
        },
        required: ['event'],
      },
    });
  }

  // Add connect_expert tool for transfer when agent answers
  if (callMode !== 'ai_full' && params.callbackPhone) {
    tools.push({
      name: 'connect_expert',
      description: `Notify our system that you are about to transfer the call to ${params.expertName}. Use this right before you say "transfer" to connect the expert. Always call this tool first, then say you are transferring.`,
      url: `${appUrl}/api/expert/irs-call/transfer-notify`,
      method: 'POST',
      headers: { 'x-bland-secret': webhookSecret },
      input_schema: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'The call session ID',
            default: params.metadata.sessionId,
          },
          reason: {
            type: 'string',
            description: 'Why the transfer is happening (e.g. "IRS agent answered")',
          },
        },
        required: [],
      },
    });

    // Bland AI native transfer configuration
    body.transfer_phone_number = params.callbackPhone;
  }

  body.tools = tools;

  const response = await fetch(`${BLAND_API_BASE}/calls`, {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Bland AI call initiation failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return {
    call_id: data.call_id,
    status: data.status || 'queued',
    message: data.message,
  };
}

/**
 * Transfer an active call to the expert's phone.
 * Uses Bland AI's call update endpoint to trigger a warm transfer.
 */
export async function transferCall(blandCallId: string, phoneNumber: string): Promise<void> {
  const apiKey = getApiKey();

  const response = await fetch(`${BLAND_API_BASE}/calls/${blandCallId}/transfer`, {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ phone_number: phoneNumber }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Bland AI transfer failed (${response.status}): ${errorText}`);
  }
}

/**
 * Get a WebSocket URL to listen to a live call.
 * Returns the WSS URL that streams PCM Int16 mono audio at 16kHz.
 */
export async function getLiveListenUrl(blandCallId: string): Promise<string> {
  const apiKey = getApiKey();

  const response = await fetch(`${BLAND_API_BASE}/calls/${blandCallId}/listen`, {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Bland AI live listen failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.data?.url || data.url;
}

/**
 * Get the current status and details of a call.
 */
export async function getCallStatus(blandCallId: string): Promise<BlandCallDetails> {
  const apiKey = getApiKey();

  const response = await fetch(`${BLAND_API_BASE}/calls/${blandCallId}`, {
    method: 'GET',
    headers: {
      'Authorization': apiKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Bland AI status check failed (${response.status}): ${errorText}`);
  }

  return await response.json();
}

/**
 * Stop an in-progress call.
 */
export async function stopCall(blandCallId: string): Promise<void> {
  const apiKey = getApiKey();

  const response = await fetch(`${BLAND_API_BASE}/calls/${blandCallId}/stop`, {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Bland AI stop call failed (${response.status}): ${errorText}`);
  }
}

/**
 * Parse a call transcript to detect per-entity outcomes.
 * Returns an array of detected outcomes mapped by entity index.
 */
export function parseTranscriptOutcomes(
  transcript: string,
  entityCount: number
): { outcome: string; notes: string }[] {
  const outcomes: { outcome: string; notes: string }[] = [];

  // Default all entities to unknown
  for (let i = 0; i < entityCount; i++) {
    outcomes.push({ outcome: 'other', notes: '' });
  }

  const lower = transcript.toLowerCase();

  // Detect global failures that affect all entities
  if (lower.includes('caf number') && (lower.includes('not on file') || lower.includes('not found'))) {
    return outcomes.map(() => ({ outcome: 'caf_not_on_file', notes: 'CAF number not on file at IRS' }));
  }

  // Detect per-entity patterns
  const successPatterns = [
    'sent to your inbox',
    'transcripts have been sent',
    'sent to your secure object repository',
    'will be in your inbox',
    'sending those over',
    'i\'ll send those',
    'i\'ve sent',
    'faxing those over',
    'sent to sor',
  ];

  const nameMatchPatterns = [
    'name doesn\'t match',
    'name does not match',
    'different name on file',
    'not matching',
    'name mismatch',
  ];

  const esigPatterns = [
    'wet signature',
    'electronic signature',
    'e-signature',
    'docusign',
    'digitally signed',
    'need a wet',
    'ink signature',
  ];

  const no8821Patterns = [
    '8821 not on file',
    'no authorization',
    'not authorized',
    'no 8821',
    'no form 8821',
    'don\'t have authorization',
  ];

  // If we detect success markers, assume all entities succeeded unless specific failures noted
  const hasSuccess = successPatterns.some(p => lower.includes(p));
  const hasNameMismatch = nameMatchPatterns.some(p => lower.includes(p));
  const hasEsigIssue = esigPatterns.some(p => lower.includes(p));
  const hasNo8821 = no8821Patterns.some(p => lower.includes(p));

  if (hasSuccess && !hasNameMismatch && !hasEsigIssue && !hasNo8821) {
    // All entities likely succeeded
    return outcomes.map(() => ({ outcome: 'transcripts_requested', notes: 'Transcripts requested successfully' }));
  }

  if (hasNameMismatch) {
    // At least one entity had a name mismatch — mark last entity as mismatch, others as requested
    for (let i = 0; i < entityCount; i++) {
      if (i === entityCount - 1 && !hasSuccess) {
        outcomes[i] = { outcome: 'name_mismatch', notes: 'Business name did not match IRS records' };
      } else if (hasSuccess) {
        outcomes[i] = { outcome: 'transcripts_requested', notes: '' };
      }
    }
  }

  if (hasEsigIssue) {
    for (let i = 0; i < entityCount; i++) {
      if (outcomes[i].outcome === 'other') {
        outcomes[i] = { outcome: '8821_esig_rejected', notes: 'IRS requires wet signature on faxed 8821' };
      }
    }
  }

  if (hasNo8821) {
    for (let i = 0; i < entityCount; i++) {
      if (outcomes[i].outcome === 'other') {
        outcomes[i] = { outcome: 'no_8821_on_file', notes: 'Form 8821 not on file at IRS' };
      }
    }
  }

  return outcomes;
}

/**
 * Extract IRS agent info from transcript.
 */
export function extractAgentInfo(transcript: string): { name?: string; badge?: string } {
  const result: { name?: string; badge?: string } = {};

  // Look for badge/ID number patterns
  const badgeMatch = transcript.match(/(?:badge|id|identification)\s*(?:number\s*)?(?:is\s*)?(\d{6,12})/i);
  if (badgeMatch) {
    result.badge = badgeMatch[1];
  }

  // Look for agent name patterns (e.g., "This is Ms. Johnson" or "My name is Johnson")
  const nameMatch = transcript.match(/(?:this is|my name is|i'm|i am)\s+(?:mr\.|mrs\.|ms\.|miss)?\s*([A-Z][a-z]+)/i);
  if (nameMatch) {
    result.name = nameMatch[0].replace(/(?:this is|my name is|i'm|i am)\s+/i, '').trim();
  }

  return result;
}
