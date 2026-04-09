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

  /** Entities to process in this call (up to 5) */
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
  const entityList = params.entities
    .map((e, i) => {
      const tidLabel = e.tidKind === 'SSN' ? 'Social Security Number' : 'Employer Identification Number';
      return `${i + 1}. ${e.taxpayerName}, ${tidLabel} ${e.taxpayerTid}, requesting Record of Account and Tax Return transcripts for Form ${e.formType}, tax years ${e.years.join(', ')}. Authorization: Form 8821 on file.`;
    })
    .join('\n');

  return `You are ${params.expertName}, a tax professional calling the IRS Practitioner Priority Service.
Your CAF number is ${params.cafNumber}.${params.expertFax ? ` Your fax number is ${params.expertFax}.` : ''}

You are calling to request tax transcripts for ${params.entities.length} client${params.entities.length > 1 ? 's' : ''}:

${entityList}

PHONE TREE NAVIGATION:
- When the automated system answers, press 1 for English.
- Press ${params.entities[0].tidKind === 'SSN' ? '2 for individual account inquiries' : '3 for business account inquiries'}.
- If prompted for a Social Security Number or EIN, enter ${params.entities[0].taxpayerTid} using the keypad.
- If offered a callback option, decline it and stay on hold.
- Wait patiently on hold until a live IRS agent answers.

WHEN THE IRS AGENT ANSWERS:
1. Greet them professionally: "Hi, this is ${params.expertName}, CAF number ${params.cafNumber}."
2. Say you have ${params.entities.length} client${params.entities.length > 1 ? 's' : ''} to process today.
3. For each client, clearly provide:
   - The taxpayer's full name
   - Their ${params.entities[0].tidKind === 'SSN' ? 'Social Security Number' : 'EIN'}
   - Which transcripts you need (Record of Account and Tax Return)
   - The form type and tax years
4. If the agent asks for your fax number, provide: ${params.expertFax || 'your fax number on file'}.
5. If the agent needs to verify the 8821 authorization: confirm it was filed electronically via IRS e-Services.
6. If the agent says the business name doesn't match their records: ask them what name they have on file, then note the discrepancy.
7. If the agent asks you to fax the 8821: say "Sure, what fax number should I use?" and then use the send_fax tool with the fax number they provide.
8. Confirm transcripts will be sent to your Secure Object Repository inbox.
9. After all clients are processed, thank the agent and end the call.

IMPORTANT RULES:
- Be patient, professional, and concise. Speak clearly and at a moderate pace.
- Do NOT volunteer unnecessary information.
- If the agent puts you on hold mid-call, wait silently without speaking.
- If the agent asks a question you cannot answer, say "Let me check on that" and note it.
- Spell out names letter by letter if asked (use NATO phonetic alphabet).
- Read SSN/EIN digits one at a time with brief pauses.`;
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
- When the automated system answers, press 1 for English.
- Press ${params.entities[0].tidKind === 'SSN' ? '2 for individual account inquiries' : '3 for business account inquiries'}.
- If prompted for a Social Security Number or EIN, enter ${params.entities[0].taxpayerTid} using the keypad.
- LISTEN for the estimated wait time. The IRS will say something like "We estimate your wait time to be between X and Y minutes."

As soon as you hear the estimated wait time, use the notify_status tool to report:
  event: "wait_estimate"
  estimated_wait_minutes: (the number they said, use the higher number if a range)

===== STEP 2: DECIDE — HOLD OR CALLBACK =====

IF estimated wait is 15 MINUTES OR LESS:
- When offered a callback, press 2 to DECLINE and stay on hold.
- Use notify_status with event: "holding" and estimated_wait_minutes.
- Wait patiently. Do NOT speak during hold music or recorded messages.
- Do NOT hang up. You MUST stay on hold for up to 90 minutes.
- Hold music, silence, and recorded announcements are NORMAL.
- Only respond when a LIVE HUMAN speaks to you directly.

IF estimated wait is MORE THAN 15 MINUTES AND callback is offered:
- Press 1 to ACCEPT the callback.
- When prompted for a phone number, enter: ${callbackDigits} using the keypad.
- If asked to confirm, press 1.
- If asked for a name, say: "${params.expertName}".
- Use notify_status with event: "callback_accepted", estimated_wait_minutes, and callback_phone: "${params.callbackPhone}".
- Once confirmed, end the call.

IF NO CALLBACK IS OFFERED (regardless of wait time):
- Stay on hold. Follow the holding instructions above.

===== STEP 3: PRE-CONNECT THE EXPERT =====
IMPORTANT: You must connect the expert BEFORE the IRS agent answers.

After you have been on hold for approximately (estimated_wait - 3) minutes:
- Use the connect_expert tool to bring ${params.expertName} onto the call at ${params.callbackPhone}.
- Use notify_status with event: "expert_pre_connected".
- Then continue waiting silently on hold.
- The expert will join the call and hear the hold music with you.
- When the IRS agent answers, the expert is already on the line and can speak directly.

For example: if IRS says "10 to 15 minutes", use connect_expert after about 7-8 minutes of holding.
If IRS says "5 minutes", use connect_expert after about 2-3 minutes of holding.

AFTER connecting the expert, if the IRS agent answers:
- Do NOT speak. The expert (${params.expertName}) is already on the line and will handle it.
- Stay silent and let the expert talk to the agent.

IF the IRS agent answers BEFORE you connect the expert (edge case):
- Say: "Hello, one moment while I connect you with ${params.expertName}."
- Immediately use connect_expert to bring ${params.expertName} on.
- Use notify_status with event: "agent_answered".

===== CRITICAL RULES =====
- Do NOT hang up during hold. Stay on the line no matter what.
- Do NOT speak during hold music or recorded messages.
- Do NOT provide any taxpayer information — only ${params.expertName} can do that.
- ALWAYS use notify_status to report what is happening. This is critical for tracking.
- ALWAYS connect the expert 2-3 minutes BEFORE the estimated wait ends.`;
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

  const body: Record<string, unknown> = {
    phone_number: '+18668604259', // IRS PPS
    record: true,
    max_duration: maxDuration,
    wait_for_greeting: true,
    amd: false,                   // Disable answering machine detection — IRS hold music triggers false positives
    interruption_threshold: 200,  // High threshold to avoid interrupting IRS hold messages
    webhook: `${appUrl}/api/webhook/bland-call-complete`,
    metadata: params.metadata,
    request_data: {
      expert_name: params.expertName,
      caf_number: params.cafNumber,
      expert_fax: params.expertFax || '',
      expert_phone: params.expertPhone || '',
      entities: params.entities,
    },
  };

  const callMode = params.callMode || 'hold_and_transfer';

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
      description: `Connect the call to ${params.expertName} at ${params.callbackPhone}. Use this when a live IRS agent has answered and you need to connect them with the expert.`,
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
