/**
 * Anthropic Claude integration for the in-app processor Q&A.
 *
 * The endpoint is server-side only — the API key never reaches the browser.
 * Falls back to "log + escalate" when ANTHROPIC_API_KEY is not configured
 * so the feature degrades gracefully instead of crashing the dashboard.
 */

import { buildProcessorSystemPrompt } from './processor-faq';

export interface AskResult {
  answer: string;
  confidence: 'high' | 'medium' | 'low';
  shouldEscalate: boolean;
  escalationReason: string | null;
  model: string | null;
  /** True when ANTHROPIC_API_KEY isn't set — UI shows "logged for admin review". */
  fallback?: boolean;
}

const MODEL = 'claude-3-5-sonnet-20241022';
const MAX_TOKENS = 600;

export async function askProcessorAI(question: string): Promise<AskResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[processor-ai] ANTHROPIC_API_KEY not set — falling back to admin escalation');
    return {
      answer: 'Your question has been logged. Matt will follow up within a few hours.',
      confidence: 'low',
      shouldEscalate: true,
      escalationReason: 'AI not configured — falling back to human review',
      model: null,
      fallback: true,
    };
  }

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
        system: buildProcessorSystemPrompt(),
        messages: [{ role: 'user', content: question }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[processor-ai] Anthropic API error:', res.status, text);
      return errorFallback(`Anthropic API returned ${res.status}`);
    }

    const data: any = await res.json();
    const content: string = data?.content?.[0]?.text || '';
    if (!content) return errorFallback('Empty response from AI');

    // The system prompt requires a JSON-only response. Parse it.
    let parsed: any;
    try {
      // Defensive: strip leading "```json"/"```" if the model wraps in fences
      const cleaned = content.trim().replace(/^```(?:json)?\n?/i, '').replace(/```$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      // If the AI didn't return valid JSON, use the raw text as answer and
      // mark medium confidence — better than nothing.
      return {
        answer: content.trim(),
        confidence: 'medium',
        shouldEscalate: false,
        escalationReason: null,
        model: MODEL,
      };
    }

    return {
      answer: (parsed.answer || '').toString().trim() || 'No answer returned.',
      confidence: (['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium') as 'high' | 'medium' | 'low',
      shouldEscalate: !!parsed.should_escalate,
      escalationReason: parsed.escalation_reason || null,
      model: MODEL,
    };
  } catch (err) {
    console.error('[processor-ai] call failed:', err);
    return errorFallback(err instanceof Error ? err.message : String(err));
  }
}

function errorFallback(reason: string): AskResult {
  return {
    answer: 'I couldn\'t reach the AI service right now. Your question has been logged for Matt to review.',
    confidence: 'low',
    shouldEscalate: true,
    escalationReason: `AI service unavailable: ${reason}`,
    model: null,
  };
}
