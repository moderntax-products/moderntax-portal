/**
 * Admin support agent — front-line triage for the entity-notes inbox.
 *
 * Matt 2026-06-23: "The admin function needs an agent that can answer all
 * inquiries, notes, and know when SLAs aren't being met. It should handle all
 * note responses and only notify the true admin when something is outside of
 * their service area."
 *
 * Decisions captured at build time:
 *   - Auto-send all IN-SCOPE replies (Matt's explicit exception to the standing
 *     "see it first" rule). Rollout is gated behind ADMIN_AGENT_AUTOSEND so the
 *     first batch posts as a digest-to-Matt until he flips it live.
 *   - The ONLY always-escalate service-area boundary Matt selected is
 *     AUTHORIZATION / LEGAL. Everything else (status, billing, how-to,
 *     complaints) the agent may answer itself.
 *   - No-hallucination floor (engineering guardrail, not a policy change): if
 *     the agent can't ground an answer in the supplied context, it escalates
 *     instead of guessing.
 *
 * Server-side only — the Anthropic key never reaches the browser. Same call
 * pattern as lib/processor-ai.ts / lib/extract-8821-vision.ts.
 */

import { PROCESSOR_FAQ } from './processor-faq';

const MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 900;

/** Curated 8821 / IRS / ERC / workflow Q&A, reused as the agent's knowledge base. */
function knowledgeBase(): string {
  return PROCESSOR_FAQ
    .map((e, i) => `[${i + 1}] ${e.topic}\n  Q: ${e.question}\n  A: ${e.answer}`)
    .join('\n\n');
}

/** Categories the agent must NEVER auto-answer — always hand to the human admin. */
export const ALWAYS_ESCALATE_CATEGORIES = ['authorization_legal'] as const;

export interface ThreadContext {
  entityName: string;
  loanNumber: string | null;
  clientName: string | null;
  formType: string | null;
  years: string[] | null;
  entityStatus: string | null;
  requestStatus: string | null;
  signed8821OnFile: boolean;
  transcriptsReadyCount: number;
  sla: { overdue: boolean; note?: string } | null;
  /** The specific inquiry being answered (the latest inbound note). */
  inquiry: { authorRole: string; authorName: string; body: string; kind: string };
  /** Prior messages in the thread, oldest → newest (excluding the inquiry). */
  history: { authorRole: string; authorName: string; body: string }[];
}

export interface AgentDecision {
  in_scope: boolean;
  category: 'status' | 'how_to' | 'billing' | 'authorization_legal' | 'complaint' | 'other';
  action: 'reply' | 'escalate';
  /** Customer/expert-facing reply text when action='reply'. */
  reply: string | null;
  /** Why it was handed to the human admin when action='escalate'. */
  escalation_reason: string | null;
  confidence: 'high' | 'medium' | 'low';
}

function buildSystemPrompt(): string {
  return [
    'You are ModernTax Support — the front-line admin agent for ModernTax, a service that pulls IRS',
    'tax transcripts (via signed Form 8821 authorization) for lenders, processors, tax experts, and',
    'direct taxpayer clients. You triage the in-portal message thread on a single tax entity and either',
    'answer the latest inquiry yourself or escalate it to the human admin (Matt).',
    '',
    'YOUR GOAL: resolve as many inquiries as you can on your own and MINIMIZE handoffs to the human admin.',
    'You are the admin operating on this entity\'s own thread — borrower/taxpayer specifics (names, TIN,',
    'status, balances shown in context) are EXPECTED here; do NOT escalate merely because PII is present.',
    'Lean toward answering whenever you have a grounded answer or a clear knowledge-base match.',
    '',
    'WHO YOU SERVE (answer all three — tailor tone + content to the asker):',
    '- EXPERTS (role=expert): the tax pros who retrieve transcripts. Help with retrieval method (e-Services',
    '  TDS for instant pulls vs an IRS PPS call + SOR mailbox), which transcripts/years to pull, the',
    '  designee 8821 (regenerate-with-their-creds), SLA/timing, uploading results, and the Flag-Issue path.',
    '- PROCESSORS / MANAGERS (role=processor/manager): lender staff who submitted the request. Help with',
    '  order status & timeline, "where are my transcripts" / downloads, 8821 rules (see KB), reorders, and',
    '  intake. Be direct and practical — they are busy.',
    '- DIRECT TAXPAYERS (role=direct_user): ModernTax Direct clients resolving their own taxes. Help with',
    '  their status & resolution roadmap, the filing intake, the $50/return filing fee + their deposit',
    '  credit, payment, and what happens next. Be warm and plain-spoken — no jargon.',
    '',
    'GROUND EVERY ANSWER IN THE PROVIDED CONTEXT + KNOWLEDGE BASE. You are given the entity, its status,',
    'form/years, whether the 8821 is on file, transcripts-ready count, SLA state, the message history, and',
    'an authoritative KB below. NEVER invent prices, dates, balances, authorization facts, or commitments',
    'that are not in the context or KB. If you genuinely cannot ground an answer, escalate (do not guess).',
    '',
    'THE ONLY THING OUTSIDE YOUR SERVICE AREA — ALWAYS ESCALATE (action="escalate",',
    'category="authorization_legal"), never answer yourself: questions about AUTHORIZATION or LEGAL scope —',
    'what we are/aren\'t authorized to pull, Form 8821/2848 scope, CAF numbers, state authorizations',
    '(GEN-58 / SC2848), whether an authorization covers a given form or year, and any compliance / legal /',
    'regulatory / tax-advice question. Everything else (status, how-to, billing/credit from context,',
    'complaints, timing) you should handle yourself.',
    '',
    'Respond with STRICT JSON only (no prose, no code fences):',
    '{',
    '  "in_scope": boolean,                       // false ⇒ must escalate',
    '  "category": "status|how_to|billing|authorization_legal|complaint|other",',
    '  "action": "reply" | "escalate",',
    '  "reply": string|null,                      // the message to send when action="reply"',
    '  "escalation_reason": string|null,          // short reason for the human admin when action="escalate"',
    '  "confidence": "high|medium|low"',
    '}',
    '',
    '═══ KNOWLEDGE BASE (authoritative — answer FROM this when it matches) ═══',
    knowledgeBase(),
  ].join('\n');
}

function buildUserPrompt(ctx: ThreadContext): string {
  const lines: string[] = [];
  lines.push('ENTITY CONTEXT:');
  lines.push(`- Entity: ${ctx.entityName}`);
  if (ctx.clientName) lines.push(`- Client: ${ctx.clientName}`);
  if (ctx.loanNumber) lines.push(`- Loan #: ${ctx.loanNumber}`);
  if (ctx.formType) lines.push(`- Form: ${ctx.formType}${ctx.years?.length ? ` for ${ctx.years.join(', ')}` : ''}`);
  lines.push(`- Entity status: ${ctx.entityStatus || 'unknown'} | Request status: ${ctx.requestStatus || 'unknown'}`);
  lines.push(`- Signed 8821 on file: ${ctx.signed8821OnFile ? 'yes' : 'no'}`);
  lines.push(`- Transcripts ready: ${ctx.transcriptsReadyCount}`);
  if (ctx.sla) lines.push(`- SLA: ${ctx.sla.overdue ? 'OVERDUE' : 'on track'}${ctx.sla.note ? ` (${ctx.sla.note})` : ''}`);
  lines.push('');
  if (ctx.history.length) {
    lines.push('THREAD HISTORY (oldest first):');
    for (const h of ctx.history) lines.push(`  [${h.authorRole}] ${h.authorName}: ${h.body}`);
    lines.push('');
  }
  lines.push('INQUIRY TO HANDLE (the latest message, awaiting a response):');
  lines.push(`  [${ctx.inquiry.authorRole}] ${ctx.inquiry.authorName} (kind=${ctx.inquiry.kind}): ${ctx.inquiry.body}`);
  lines.push('');
  lines.push('Decide and respond with the strict JSON object.');
  return lines.join('\n');
}

/** Safe fallback used when the AI is unconfigured or errors — always escalates. */
function escalateFallback(reason: string): AgentDecision {
  return {
    in_scope: false,
    category: 'other',
    action: 'escalate',
    reply: null,
    escalation_reason: reason,
    confidence: 'low',
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Proactive outreach — the agent reaches OUT to whoever owes a task (an expert
// sitting on an overdue SLA, a processor with an unsigned 8821), speaking like
// a normal support agent. Modeled on the admin→expert/processor note voice.
// ───────────────────────────────────────────────────────────────────────────

export interface OutreachContext {
  audience: 'expert' | 'processor';
  recipientName: string;
  entityName: string;
  loanNumber: string | null;
  formType: string | null;
  years: string[] | null;
  /** What's going on, in plain facts — e.g. "past the 24h turnaround SLA". */
  situation: string;
  /** The concrete ask — e.g. "wrap it up today or tell us if you're blocked". */
  ask: string;
}

/** Plain-text, support-voice fallback used when the AI is unavailable. */
function outreachFallback(ctx: OutreachContext): string {
  const who = ctx.recipientName ? `Hi ${ctx.recipientName.split(' ')[0]},` : 'Hi,';
  const ref = `${ctx.entityName}${ctx.loanNumber ? ` (loan ${ctx.loanNumber})` : ''}`;
  return `${who} just checking in on ${ref} — ${ctx.situation}. ${ctx.ask} Happy to help if anything's in the way. — ModernTax Support`;
}

/**
 * Compose a brief, warm check-in message for proactive outreach. Always returns
 * a sendable string (AI when available, grounded template otherwise) so a nudge
 * never silently fails.
 */
export async function composeOutreach(ctx: OutreachContext): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return outreachFallback(ctx);

  const system = [
    'You are ModernTax Support sending a brief in-portal check-in note to a',
    `${ctx.audience} on our team's workflow. Speak like a warm, professional HUMAN support agent —`,
    'never a bot, never a cold templated reminder. 1–3 sentences. Reference the specific entity/loan',
    'and the situation, make ONE clear and kind ask, and offer help if they are blocked. Do not be',
    'pushy, threatening, or guilt-trippy. Do NOT invent any facts beyond what you are given. End with',
    '"— ModernTax Support". Output ONLY the message text — no preamble, no quotes, no JSON.',
  ].join(' ');
  const user = [
    `Recipient: ${ctx.recipientName} (${ctx.audience})`,
    `Entity: ${ctx.entityName}${ctx.loanNumber ? ` · loan ${ctx.loanNumber}` : ''}`,
    ctx.formType ? `Form: ${ctx.formType}${ctx.years?.length ? ` for ${ctx.years.join(', ')}` : ''}` : '',
    `Situation: ${ctx.situation}`,
    `Ask: ${ctx.ask}`,
    '',
    'Write the check-in note now.',
  ].filter(Boolean).join('\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 300, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) return outreachFallback(ctx);
    const data: any = await res.json();
    const text: string = (data?.content?.[0]?.text || '').trim();
    return text || outreachFallback(ctx);
  } catch (err) {
    console.error('[admin-agent] composeOutreach failed:', err);
    return outreachFallback(ctx);
  }
}

export async function decideOnThread(ctx: ThreadContext): Promise<AgentDecision> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return escalateFallback('AI not configured (ANTHROPIC_API_KEY unset) — needs human review');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: buildUserPrompt(ctx) }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[admin-agent] Anthropic API error:', res.status, text);
      return escalateFallback(`AI service error (${res.status})`);
    }
    const data: any = await res.json();
    const content: string = data?.content?.[0]?.text || '';
    if (!content) return escalateFallback('Empty AI response');

    let parsed: any;
    try {
      const cleaned = content.trim().replace(/^```(?:json)?\n?/i, '').replace(/```$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return escalateFallback('AI returned non-JSON — needs human review');
    }

    const category = ['status', 'how_to', 'billing', 'authorization_legal', 'complaint', 'other']
      .includes(parsed.category) ? parsed.category : 'other';
    let action: 'reply' | 'escalate' = parsed.action === 'reply' ? 'reply' : 'escalate';
    const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : null;

    // Hard guardrails the code enforces regardless of what the model returned:
    //  1. Always-escalate categories can never be auto-answered.
    //  2. A "reply" with no actual text must escalate (don't post an empty note).
    if ((ALWAYS_ESCALATE_CATEGORIES as readonly string[]).includes(category)) action = 'escalate';
    if (action === 'reply' && !reply) action = 'escalate';

    return {
      in_scope: action === 'reply',
      category,
      action,
      reply: action === 'reply' ? reply : null,
      escalation_reason: action === 'escalate'
        ? (parsed.escalation_reason || `Out of service area (${category})`)
        : null,
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
    };
  } catch (err) {
    console.error('[admin-agent] call failed:', err);
    return escalateFallback(err instanceof Error ? err.message : String(err));
  }
}
