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

const MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 900;

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
    'WHO YOU TALK TO: experts (who pull the transcripts), processors/managers (lender staff who submit',
    'requests), and direct taxpayer clients. Be warm, concise, and professional. Sign replies "— ModernTax Support".',
    '',
    'GROUND EVERY ANSWER IN THE PROVIDED CONTEXT. You are given the entity, its status, form/years,',
    'whether the 8821 is on file, how many transcripts are ready, SLA state, and the message history.',
    'NEVER invent prices, dates, balances, authorization facts, or commitments that are not in the context.',
    'If you cannot answer confidently from the context, you MUST escalate (do not guess).',
    '',
    'ALWAYS ESCALATE (action="escalate", category="authorization_legal") — never answer yourself — when the',
    'inquiry concerns AUTHORIZATION or LEGAL scope: what we are/aren\'t authorized to pull, Form 8821/2848',
    'scope, CAF numbers, state authorizations (GEN-58/SC2848), whether an authorization covers a form or',
    'year, compliance, or any legal/regulatory question. These are outside your service area.',
    '',
    'OTHERWISE you may answer in scope: order status & timeline, "where are my transcripts", how-to',
    '(TDS vs PPS call + SOR mailbox, portal navigation, downloads, intake), and general support — using',
    'ONLY the facts in the context. Billing/credit questions: answer only from facts present in the',
    'context; if specifics aren\'t supplied, escalate rather than improvise numbers.',
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
