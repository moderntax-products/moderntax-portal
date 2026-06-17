'use client';

/**
 * Processor-facing customer-service channel, per entity.
 *
 * Repurposes the admin↔expert entity-notes backend (kind='support'): a
 * processor raises a question/issue on a specific entity ("transcripts ready
 * but only the 8821 downloads"), it emails the ModernTax support inbox, and
 * the admin reply comes back here. Only support-kind notes are loaded
 * (?kind=support), so the internal admin↔expert chatter on the same entity is
 * never exposed to the processor.
 *
 * Built 2026-06-17 from Sonja Lewis (Cal Statewide) asking "is there a
 * customer service email or phone number I should use?" — now there's an
 * in-portal channel tied to the exact entity in question.
 */

import { useEffect, useState, useCallback } from 'react';

interface SupportNote {
  id: string;
  author_id: string | null;
  author_role: 'admin' | 'expert' | 'processor' | 'manager';
  author_name: string;
  body: string;
  kind: string;
  created_at: string;
}

interface Props {
  entityId: string;
  entityName: string;
}

// The processor should see admin replies as "ModernTax Support", never an
// individual admin's name (mirrors the email masking in the notes route).
function displayName(n: SupportNote): string {
  return n.author_role === 'admin' ? 'ModernTax Support' : n.author_name;
}

export function SupportTicketPanel({ entityId, entityName }: Props) {
  const [notes, setNotes] = useState<SupportNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/entity-notes/${entityId}?kind=support`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setError(data.error || `HTTP ${res.status}`); return; }
      setNotes(data.notes || []);
    } catch (err: any) {
      setError(err?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  }, [entityId]);

  useEffect(() => { refresh(); }, [refresh]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setSubmitting(true); setError(null);
    try {
      const res = await fetch(`/api/entity-notes/${entityId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: body.trim(), kind: 'support' }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error || `Couldn't send (HTTP ${res.status}). Please email support@moderntax.io.`);
        return;
      }
      setBody('');
      setSent(true);
      await refresh();
    } catch (err: any) {
      setError(err?.message || 'Network error — please email support@moderntax.io.');
    } finally {
      setSubmitting(false);
    }
  };

  const ticketCount = notes.filter((n) => n.author_role === 'processor' || n.author_role === 'manager').length;

  return (
    <div className="mt-4 border-t border-gray-200 pt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-sm font-medium text-mt-green hover:underline"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 10c0 3.866-3.582 7-8 7a8.84 8.84 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7z" />
        </svg>
        {open ? 'Hide support' : 'Need help with this entity? Contact support'}
        {!open && notes.length > 0 && (
          <span className="ml-1 inline-flex items-center justify-center px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 text-[10px] font-semibold">
            {notes.length}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-3">
          {loading ? (
            <p className="text-xs text-gray-400">Loading…</p>
          ) : (
            <>
              {notes.length > 0 && (
                <div className="space-y-2 mb-3 max-h-72 overflow-y-auto">
                  {notes.map((n) => {
                    const fromSupport = n.author_role === 'admin';
                    return (
                      <div
                        key={n.id}
                        className={`rounded-lg px-3 py-2 text-xs border ${fromSupport ? 'bg-green-50 border-green-200' : 'bg-gray-50 border-gray-200'}`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`font-semibold ${fromSupport ? 'text-green-800' : 'text-gray-800'}`}>
                            {displayName(n)}
                          </span>
                          <span className="text-[10px] text-gray-400 ml-auto">
                            {new Date(n.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                          </span>
                        </div>
                        <p className="text-gray-800 whitespace-pre-wrap">{n.body}</p>
                      </div>
                    );
                  })}
                </div>
              )}

              {sent && (
                <div className="mb-3 text-xs text-green-800 bg-green-50 border border-green-200 rounded p-2">
                  ✓ Sent to ModernTax Support. We&apos;ll reply by email and post the response here.
                </div>
              )}

              <form onSubmit={submit} className="space-y-2">
                <textarea
                  value={body}
                  onChange={(e) => { setBody(e.target.value); setSent(false); }}
                  disabled={submitting}
                  placeholder={`Describe the issue with ${entityName} — e.g. "transcripts show as ready but I can only download the 8821."`}
                  rows={3}
                  maxLength={4000}
                  className="w-full text-sm px-3 py-2 border border-gray-300 rounded-lg resize-y disabled:opacity-50 focus:ring-2 focus:ring-mt-green focus:border-transparent"
                />
                {error && (
                  <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-400">
                    {ticketCount > 0 ? `${ticketCount} message${ticketCount === 1 ? '' : 's'} sent` : 'Goes to ModernTax Support'} · or email support@moderntax.io
                  </span>
                  <button
                    type="submit"
                    disabled={submitting || !body.trim()}
                    className="px-3 py-1.5 text-sm font-semibold bg-mt-green text-white rounded-lg hover:opacity-90 disabled:opacity-50"
                  >
                    {submitting ? 'Sending…' : 'Send to support'}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      )}
    </div>
  );
}
