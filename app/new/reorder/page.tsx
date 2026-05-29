/**
 * /new/reorder — processor-facing self-serve reorder flow.
 *
 * Driver: 2026-05-28 Matt — "Build this feature for reorders where
 * Processors can self-serve a reorder from their dashboard." Today
 * Soobin emails Matt; with this page she can do it herself in 60s.
 *
 * Behavior:
 *   - Fetches the current user's own entity history (deduped by TID,
 *     newest first) from the now-widened /api/admin/processor-entity-history
 *     endpoint. Auth gates to "own history only" for non-admin callers.
 *   - Processor picks one prior entity, picks the new years to pull,
 *     enters a loan number, optionally adds notes, submits.
 *   - Server clones the entity, reuses the existing 8821 if within the
 *     120-day window, lands the new request in the IRS queue (or
 *     'pending' if a fresh 8821 is needed).
 *   - Billed as the $29.99 reorder SKU at end-of-month.
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import Link from 'next/link';

interface HistoryItem {
  entity_id: string;
  entity_name: string;
  tid: string;
  tid_masked: string;
  tid_kind: string;
  form_type: string;
  latest_loan_number: string | null;
  latest_status: string;
  latest_created_at: string;
  years_previously_pulled: string[];
  prior_request_count: number;
  transcript_count: number;
  signed_8821_url: string | null;
  signature_age_days: number | null;
  signature_still_valid: boolean;
  signed_8821_valid_window_days: number;
}

export default function ProcessorReorderPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [entityId, setEntityId] = useState('');
  const [years, setYears] = useState<string[]>([]);
  const [loanNumber, setLoanNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [success, setSuccess] = useState<{ request_id: string; reused_8821: boolean; new_years: number[]; entity_name: string } | null>(null);

  const currentYear = new Date().getFullYear();
  const TAX_YEARS = Array.from({ length: 6 }, (_, i) => String(currentYear - i));

  useEffect(() => {
    (async () => {
      const sb = createClient();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) { router.push('/login'); return; }
      setUserId(user.id);
      try {
        const res = await fetch(`/api/admin/processor-entity-history?processor_id=${encodeURIComponent(user.id)}`);
        const data = await res.json();
        if (!res.ok) { setError(data.error || 'Could not load history'); }
        else { setItems(data.items || []); }
      } catch (err: any) {
        setError(err?.message || 'Network error loading history');
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  const selected = useMemo(() => items.find((h) => h.entity_id === entityId) || null, [items, entityId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!entityId) { setError('Pick a prior entity first.'); return; }
    if (years.length === 0) { setError('Pick at least one year to re-pull.'); return; }
    if (!loanNumber.trim()) { setError('Loan number is required.'); return; }
    if (!userId) { setError('Session expired — refresh and try again.'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/reorder-from-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          processor_id: userId,
          source_entity_id: entityId,
          new_years: years,
          loan_number: loanNumber.trim(),
          notes: notes.trim() || undefined,
          reuse_8821: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Reorder failed.'); return; }
      setSuccess({
        request_id: data.request_id,
        reused_8821: data.reused_8821,
        new_years: data.new_years,
        entity_name: selected?.entity_name || 'Entity',
      });
    } catch (err: any) {
      setError(err?.message || 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12 text-sm text-gray-500">Loading your history…</div>
    );
  }

  if (success) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12">
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
          </div>
          <h2 className="text-2xl font-bold text-mt-dark mb-2">Reorder created</h2>
          <p className="text-gray-600 mb-6">
            <strong>{success.entity_name}</strong> re-pull queued for years {success.new_years.join(', ')}.
            {success.reused_8821
              ? ' Existing 8821 reused — no new signature needed.'
              : ' A fresh 8821 will be required before we can pull.'}
          </p>
          <p className="text-sm text-gray-500 mb-6">
            This new request will be billed at <strong>$29.99</strong> (Reorder rate) on your next invoice, not the standard verification rate.
          </p>
          <div className="flex gap-3 justify-center">
            <Link href={`/request/${success.request_id}`} className="bg-mt-green text-white px-5 py-2.5 rounded-lg font-semibold hover:bg-opacity-90 transition-colors">
              View this request →
            </Link>
            <button
              onClick={() => { setSuccess(null); setEntityId(''); setYears([]); setLoanNumber(''); setNotes(''); }}
              className="px-5 py-2.5 border border-gray-300 rounded-lg font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Reorder another
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="mb-6">
        <Link href="/new" className="text-sm text-gray-500 hover:text-gray-700">← Back to all workflows</Link>
        <h1 className="text-2xl font-bold text-mt-dark mt-2">Reorder from history</h1>
        <p className="text-gray-600 text-sm mt-1">
          Re-pull a prior entity for new years. Reuses the existing 8821 when it&apos;s within the 120-day validity window — no CSV upload, no new signature, no full verification rate. Billed at the discounted <strong>$29.99 Reorder</strong> SKU.
        </p>
      </div>

      {error && (
        <div className="mb-5 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6 space-y-5">
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1.5">
            Historical entity <span className="text-red-500">*</span>
          </label>
          {items.length === 0 ? (
            <p className="text-xs text-amber-700 italic">No prior entities found. Submit a new request via /new first, then reorders become available here.</p>
          ) : (
            <select
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
              className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-transparent outline-none"
            >
              <option value="">Pick a prior entity to reorder…</option>
              {items.map((h) => (
                <option key={h.entity_id} value={h.entity_id}>
                  {h.entity_name} · {h.form_type} · TIN {h.tid_masked} · prior years {h.years_previously_pulled.join(', ') || '—'} · loan {h.latest_loan_number || '—'}
                </option>
              ))}
            </select>
          )}
        </div>

        {selected && (
          <div className="border border-gray-200 bg-gray-50 rounded-lg p-3 text-xs space-y-1">
            <div className="font-semibold text-mt-dark">{selected.entity_name} <span className="text-gray-500 font-normal">({selected.form_type}, TIN {selected.tid_masked})</span></div>
            <div className="text-gray-600">Previously pulled: <span className="font-mono">{selected.years_previously_pulled.join(', ') || '—'}</span> · {selected.transcript_count} transcript{selected.transcript_count === 1 ? '' : 's'} on file</div>
            <div className={selected.signature_still_valid ? 'text-emerald-700' : 'text-amber-700'}>
              {!selected.signed_8821_url
                ? '⚠ No 8821 on file — a fresh one will be required.'
                : selected.signature_still_valid && selected.signature_age_days !== null
                  ? `✓ Signed 8821 on file (${selected.signature_age_days}d old, within ${selected.signed_8821_valid_window_days}d window) — will be reused.`
                  : selected.signature_age_days === null
                    ? '⚠ Signed 8821 on file but no timestamp — fresh 8821 needed.'
                    : `⚠ Signed 8821 is ${selected.signature_age_days}d old (>${selected.signed_8821_valid_window_days}d) — fresh 8821 required.`}
            </div>
          </div>
        )}

        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1.5">
            New year(s) to pull <span className="text-red-500">*</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {TAX_YEARS.map((y) => {
              const checked = years.includes(y);
              return (
                <button
                  type="button"
                  key={y}
                  onClick={() => setYears((prev) => prev.includes(y) ? prev.filter(z => z !== y) : [...prev, y].sort())}
                  className={`px-3 py-1.5 rounded text-sm font-mono border transition-colors ${checked ? 'bg-mt-green text-white border-mt-green' : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400'}`}
                >
                  {y}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1.5">
            Loan number <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={loanNumber}
            onChange={(e) => setLoanNumber(e.target.value)}
            placeholder={selected?.latest_loan_number ? `e.g. ${selected.latest_loan_number}-R1` : 'e.g. 18029-R1'}
            className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-transparent outline-none"
          />
          <p className="text-xs text-gray-500 mt-1">Suggested: suffix the original loan with <code>-R1</code> so it sorts alongside the original on the dashboard.</p>
        </div>

        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1.5">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Amended 2024 tax return filed; need refresh"
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-transparent outline-none"
          />
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-gray-100">
          <div className="text-sm">
            <span className="text-gray-500">This reorder will bill at </span>
            <strong className="text-mt-dark">$29.99</strong>
            <span className="text-gray-500"> (vs. standard verification rate)</span>
          </div>
          <button
            type="submit"
            disabled={submitting || items.length === 0}
            className="bg-mt-green text-white px-5 py-2.5 rounded-lg font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-60"
          >
            {submitting ? 'Submitting…' : 'Submit reorder'}
          </button>
        </div>
      </form>
    </div>
  );
}
