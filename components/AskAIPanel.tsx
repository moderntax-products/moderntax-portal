'use client';

/**
 * Floating "Ask AI" button + modal Q&A panel. Mounted in the processor
 * dashboard layout so it's available from every page.
 *
 * Flow:
 *   1. User clicks the floating button → modal opens
 *   2. User types question, clicks Ask
 *   3. POSTs to /api/processor/ask, displays AI answer + confidence pill
 *   4. If AI escalates: shows "I've flagged this for Matt — he'll follow up shortly"
 *   5. Below the current Q&A, shows history of last 5 Q's (collapsible)
 *
 * No borrower PII should be typed in — the prompt nudges the user away,
 * and the AI auto-escalates anything that looks PII-shaped.
 */

import { useEffect, useState } from 'react';

interface AskResponse {
  questionId: string;
  answer: string;
  confidence: 'high' | 'medium' | 'low';
  escalated: boolean;
  escalationReason: string | null;
  fallback: boolean;
}

interface HistoryRow {
  id: string;
  question_text: string;
  ai_response: string | null;
  ai_confidence: string | null;
  status: string;
  escalated_reason: string | null;
  admin_response: string | null;
  created_at: string;
  ai_response_at: string | null;
}

const CONF_COLOR: Record<string, string> = {
  high:   'bg-emerald-100 text-emerald-800 border-emerald-300',
  medium: 'bg-amber-100   text-amber-800   border-amber-300',
  low:    'bg-red-100     text-red-800     border-red-300',
};

export function AskAIPanel() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (open && history.length === 0) {
      fetch('/api/processor/questions?limit=5')
        .then(r => r.ok ? r.json() : { questions: [] })
        .then(d => setHistory(d.questions || []))
        .catch(() => {});
    }
  }, [open, history.length]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/processor/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to ask');
        return;
      }
      setResult(data);
      // Refresh history
      fetch('/api/processor/questions?limit=5')
        .then(r => r.ok ? r.json() : { questions: [] })
        .then(d => setHistory(d.questions || []))
        .catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setQuestion('');
    setResult(null);
    setError(null);
  };

  return (
    <>
      {/* Floating launch button — bottom-right, always visible to processor */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 px-4 py-3 bg-mt-green hover:bg-mt-green/90 text-white rounded-full shadow-lg flex items-center gap-2 text-sm font-semibold transition-transform hover:scale-105"
        title="Ask the ModernTax AI assistant"
        aria-label="Open AI Q&A panel"
      >
        <span className="text-base">💬</span>
        Ask AI
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4"
          onClick={() => !submitting && setOpen(false)}
        >
          <div
            className="bg-white w-full sm:max-w-2xl rounded-lg shadow-xl max-h-[90vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b">
              <div>
                <h2 className="text-base font-bold text-gray-900">Ask ModernTax AI</h2>
                <p className="text-xs text-gray-500">8821, IRS transcripts, workflow questions. Don&apos;t include borrower PII.</p>
              </div>
              <button
                onClick={() => setOpen(false)}
                disabled={submitting}
                className="text-gray-400 hover:text-gray-700 text-xl disabled:opacity-50"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {/* Question form */}
              <form onSubmit={handleSubmit} className="mb-4">
                <textarea
                  value={question}
                  onChange={e => setQuestion(e.target.value)}
                  placeholder='e.g. "Can I add Mrs. to an 8821 name?" or "What does TC 740 on a transcript mean?"'
                  rows={3}
                  maxLength={2000}
                  disabled={submitting}
                  className="w-full text-sm border border-gray-300 rounded p-2 mb-2 focus:ring-2 focus:ring-mt-green/30 focus:border-mt-green disabled:bg-gray-50"
                />
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-400">{question.length} / 2000</span>
                  <div className="flex gap-2">
                    {result && (
                      <button
                        type="button"
                        onClick={reset}
                        className="px-3 py-1.5 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50"
                      >
                        New question
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={submitting || !question.trim()}
                      className="px-4 py-1.5 text-sm font-semibold text-white bg-mt-green hover:bg-mt-green/90 rounded disabled:opacity-50"
                    >
                      {submitting ? 'Thinking…' : 'Ask'}
                    </button>
                  </div>
                </div>
              </form>

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-800 text-sm p-3 rounded mb-3">{error}</div>
              )}

              {/* AI response */}
              {result && (
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded border ${CONF_COLOR[result.confidence]}`}>
                      {result.confidence.toUpperCase()} CONFIDENCE
                    </span>
                    {result.escalated && (
                      <span className="text-xs font-bold px-2 py-0.5 rounded border bg-blue-100 text-blue-800 border-blue-300">
                        ESCALATED TO MATT
                      </span>
                    )}
                    {result.fallback && (
                      <span className="text-xs px-2 py-0.5 rounded bg-gray-200 text-gray-700">offline mode</span>
                    )}
                  </div>
                  <p className="text-sm text-gray-900 whitespace-pre-wrap">{result.answer}</p>
                  {result.escalated && result.escalationReason && (
                    <p className="text-xs text-gray-600 italic mt-2">
                      Reason: {result.escalationReason}. You&apos;ll hear back via email — your question is logged.
                    </p>
                  )}
                </div>
              )}

              {/* History */}
              {history.length > 0 && (
                <div className="mt-4 pt-4 border-t border-gray-100">
                  <button
                    onClick={() => setShowHistory(!showHistory)}
                    className="text-xs text-gray-600 hover:text-gray-900 font-medium"
                  >
                    {showHistory ? '▼' : '▶'} Recent questions ({history.length})
                  </button>
                  {showHistory && (
                    <ul className="mt-2 space-y-3">
                      {history.map(h => (
                        <li key={h.id} className="text-xs border-l-2 border-gray-200 pl-3">
                          <div className="text-gray-500 mb-0.5">
                            {new Date(h.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                            {h.status === 'escalated' && <span className="ml-2 text-blue-700 font-medium">escalated</span>}
                            {h.status === 'answered_by_admin' && <span className="ml-2 text-emerald-700 font-medium">admin answered</span>}
                          </div>
                          <div className="font-medium text-gray-800 mb-1">Q: {h.question_text}</div>
                          {h.admin_response && (
                            <div className="text-gray-700 bg-emerald-50 border border-emerald-200 rounded p-2 mb-1">
                              <strong>Matt:</strong> {h.admin_response}
                            </div>
                          )}
                          {!h.admin_response && h.ai_response && (
                            <div className="text-gray-600">{h.ai_response}</div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
