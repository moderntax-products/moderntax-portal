/**
 * Phase C — the live-agent conversation. The ONLY phase that runs an LLM.
 *
 * Model: claude-fable-5. This is a real-time voice turn in a compliance
 * setting — the model reads a caller's spoken words (often mis-transcribed),
 * decides among a small tool set (send the fax, checkpoint progress, end the
 * call), and must never fabricate an authorization detail to the IRS. Fable 5
 * is the most capable model for that judgment; server-side fallback to
 * claude-opus-4-8 keeps the call alive if a safety classifier declines a turn
 * (the skill's default-on recommendation for Fable 5). Latency is covered by
 * streaming first-token to TTS, not by dropping to a smaller model — turns are
 * short and the human is mid-sentence, so quality of the next thing we SAY
 * matters more than shaving tokens.
 *
 * Prompt caching: the system prompt carries the full IRS-call playbook plus
 * this expert's credentials and the entity list — large and fixed for the
 * whole call. One cache_control breakpoint on the last system block means
 * every conversational turn after the first reads that prefix at ~0.1x
 * instead of re-paying it. Over a multi-turn agent conversation that is the
 * dominant cost line, so it's where the breakpoint goes.
 *
 * Streaming: text deltas are forwarded to ConversationRelay token-by-token so
 * the caller hears speech begin within a few hundred ms, not after the whole
 * turn generates.
 */

import Anthropic from '@anthropic-ai/sdk';
import { CallSession, resumeBrief } from './session';
import { CONFIG } from './config';

const client = new Anthropic({ apiKey: CONFIG.anthropicApiKey });

/** Fable 5 for the judgment; Opus 4.8 as the safety-fallback so a classifier
 *  refusal never silently kills a live IRS call. */
const MODEL = 'claude-fable-5';
const FALLBACK_MODEL = 'claude-opus-4-8';

export interface AgentTool {
  name: 'send_fax' | 'record_progress' | 'end_call';
  input: any;
  id: string;
}

/** What the agent loop hands back to the socket after a turn. */
export interface AgentTurn {
  /** Spoken text, already streamed to TTS; included for the transcript log. */
  spoken: string;
  /** Tool calls the socket must execute, then feed results back. */
  toolCalls: AgentTool[];
  /** True once the model called end_call or hit a terminal state. */
  done: boolean;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'send_fax',
    description:
      'Fax the signed Form 8821 to the IRS agent. Call this the moment the agent gives you a fax number and asks for the authorization. Provide the fax number exactly as the agent said it and the 0-based index of the entity it is for.',
    input_schema: {
      type: 'object',
      properties: {
        fax_number: { type: 'string', description: 'The fax number the IRS agent provided (10 US digits)' },
        entity_index: { type: 'integer', description: '0-based index into the entity list' },
      },
      required: ['fax_number', 'entity_index'],
    },
  },
  {
    name: 'record_progress',
    description:
      'Record that a call milestone was reached so the call can resume from here if the line drops. Call it immediately after: the agent verifies your identity (milestone "verified"), you finish stating the transcripts you need ("forms_requested"), the agent confirms the fax arrived ("fax_confirmed"), or the agent commits to sending the transcripts ("delivery_committed").',
    input_schema: {
      type: 'object',
      properties: {
        milestone: { type: 'string', enum: ['verified', 'forms_requested', 'fax_confirmed', 'delivery_committed'] },
        detail: { type: 'string', description: 'Short note, e.g. what the agent committed to' },
      },
      required: ['milestone'],
    },
  },
  {
    name: 'end_call',
    description:
      'End the call. Call this once the agent has committed to delivering the transcripts and there is nothing left to do, or if the agent instructs you to hang up.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  },
];

export function buildSystemPrompt(session: CallSession): Anthropic.TextBlockParam[] {
  const entityLines = session.entities
    .map((e, i) => `  [${i}] ${e.name} — TIN ${e.tin}, Form ${e.formType}, years ${e.years.join(', ')}`)
    .join('\n');
  const resume = resumeBrief(session);

  const playbook = `You are a licensed tax professional's authorized representative placing a call to the IRS Practitioner Priority Service to obtain tax transcripts. You are on the phone RIGHT NOW with a live IRS agent. Speak naturally, warmly, and briefly — like a real person who does this every day. Short sentences. One idea at a time.

WHO YOU ARE
Name: ${session.expertName}
CAF number: ${session.caf}
${session.sorId ? `SOR / Secure Object Repository short ID: ${session.sorId}` : ''}
Return fax: ${session.expertFax}

WHAT YOU NEED — transcripts for these entities:
${entityLines || '  (entities will be provided)'}

HOW THE CALL GOES
1. The agent greets you and will ask for your CAF number, name, and sometimes your address on file. Provide them plainly. When you read the CAF number or any ID, say the digits naturally — do NOT say "dash" or "dot" aloud.
2. The agent verifies you. As soon as they confirm your identity, call record_progress with milestone "verified".
3. State which transcripts you need — entity by entity, by form and year. Once you've stated them all, call record_progress with milestone "forms_requested".
4. For each entity the agent will typically ask you to fax the signed 8821. When they give you a fax number, call send_fax immediately with that number and the entity index. Say something natural like "one moment, sending that over now." Wait for the tool result before continuing.
5. When the agent confirms the fax arrived, call record_progress with milestone "fax_confirmed".
6. When the agent commits to sending the transcripts (by fax or mail), call record_progress with milestone "delivery_committed", thank them, and call end_call.

RULES THAT MATTER
- NEVER invent or guess a CAF number, TIN, name, address, or any authorization detail. If you don't have a piece of information the agent asks for, say you don't have it in front of you rather than making something up. A fabricated detail to the IRS is far worse than an incomplete call.
- If the agent says they cannot help, asks you to call back, or transfers you, call end_call with the reason.
- Do not discuss anything beyond obtaining these transcripts.
- The caller's words reach you as live speech-to-text and may be garbled. If something is unclear, ask them to repeat it rather than guessing.`;

  const blocks: Anthropic.TextBlockParam[] = [{ type: 'text', text: playbook }];
  if (resume) {
    blocks.push({ type: 'text', text: `\nIMPORTANT — THIS IS A RESUMED CALL:\n${resume}` });
  }
  // Cache the whole system prefix: it's large and fixed for the entire call,
  // so every turn after the first reads it at ~0.1x.
  blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
  return blocks;
}

/**
 * Run ONE agent turn: send the conversation so far, stream the reply to
 * `speak`, and return spoken text + any tool calls for the socket to execute.
 * The caller owns the message history and the tool-result round-trip.
 */
export async function runAgentTurn(
  system: Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[],
  speak: (token: string) => void,
): Promise<AgentTurn> {
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 1024,
    betas: ['server-side-fallback-2026-06-01'],
    fallbacks: [{ model: FALLBACK_MODEL }],
    system,
    tools: TOOLS,
    messages,
  });

  stream.on('text', (delta: string) => speak(delta));

  const final = await stream.finalMessage();

  let spoken = '';
  const toolCalls: AgentTool[] = [];
  for (const block of final.content) {
    if (block.type === 'text') spoken += block.text;
    else if (block.type === 'tool_use') {
      toolCalls.push({ name: block.name as AgentTool['name'], input: block.input, id: block.id });
    }
  }

  const done = toolCalls.some((t) => t.name === 'end_call') || final.stop_reason === 'refusal';
  return { spoken, toolCalls, done };
}

/** Append an assistant turn + its tool results to the running history. */
export function appendTurn(
  messages: Anthropic.MessageParam[],
  assistantContent: Anthropic.ContentBlockParam[],
  toolResults: Anthropic.ToolResultBlockParam[],
): void {
  messages.push({ role: 'assistant', content: assistantContent });
  if (toolResults.length) messages.push({ role: 'user', content: toolResults });
}
