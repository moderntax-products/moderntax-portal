'use client';

/**
 * Monitoring enroll CTA — surfaced on /admin/compliance-status/[entityId]
 * when the Filing Compliance section detects one or more "no record of
 * return filed" results.
 *
 * Pitch: an unfiled-return result is the perfect monitoring upsell hook.
 * The processor paid for a pull and got nothing — but if we re-pull on
 * a cadence, we catch the return the moment it's filed and the processor
 * doesn't have to remember to ask again. Billing: $19.99 enrollment +
 * $59.98 per fresh-data pull (no-record-found pulls are NOT billed —
 * paper trail without the charge).
 *
 * Three states:
 *   1. Not enrolled        → "Enroll in monitoring" → expand frequency picker
 *   2. Active enrollment   → status pill + next pull date
 *   3. Paused / cancelled  → re-enroll prompt
 *
 * The /api/monitoring POST already does the role-based auth — this
 * component just collects the form input and routes the request.
 */

import { useState, useTransition } from 'react';

type Frequency = 'weekly' | 'monthly' | 'quarterly' | 'annual';

interface ExistingMonitoring {
  id: string;
  status: 'active' | 'paused' | 'cancelled' | 'expired';
  frequency: string;
  next_pull_date: string | null;
  last_pull_date: string | null;
  total_pulls_completed: number;
}

interface Props {
  entityId: string;
  requestId: string;
  /** Count of "no record of return filed" results on this entity. */
  unfiledCount: number;
  /** Existing monitoring subscription, if any. */
  existing?: ExistingMonitoring | null;
}

export function MonitoringEnrollCTA({ entityId, requestId, unfiledCount, existing }: Props) {
  const [open, setOpen] = useState(false);
  const [frequency, setFrequency] = useState<Frequency>('quarterly');
  const [pending, startTransition] = useTransition();
  const [enrolled, setEnrolled] = useState(existing && existing.status === 'active');
  const [enrolledMeta, setEnrolledMeta] = useState<ExistingMonitoring | null>(existing || null);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/monitoring', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entityId,
            requestId,
            frequency,
            // We DO want the initial pull to fire — that's the point: a fresh
            // sweep right now to catch any newly-filed return the borrower
            // may have just submitted between the original pull and today.
            skipInitialPull: false,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Could not enroll in monitoring');
          return;
        }
        setEnrolled(true);
        setEnrolledMeta(data.subscription);
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      }
    });
  };

  // ── State 2: already enrolled (active) ────────────────────────────────
  if (enrolled && enrolledMeta) {
    return (
      <div className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 rounded text-xs font-semibold border bg-emerald-50 border-emerald-300 text-emerald-800">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        Monitoring active · {enrolledMeta.frequency} ·{' '}
        {enrolledMeta.next_pull_date ? `next pull ${enrolledMeta.next_pull_date}` : 'next pull scheduled'}
      </div>
    );
  }

  // ── State 3: paused / cancelled — show re-enroll prompt ───────────────
  const wasCancelled = existing && ['paused', 'cancelled', 'expired'].includes(existing.status);

  // ── Trigger button (collapsed) ────────────────────────────────────────
  if (!open) {
    return (
      <div className="mt-4 bg-blue-50 border-l-4 border-blue-500 rounded-r p-4 max-w-2xl">
        <p className="text-sm font-bold text-blue-900">
          {wasCancelled
            ? '◐ Monitoring was previously paused — re-enroll?'
            : `⚠ ${unfiledCount} period${unfiledCount === 1 ? '' : 's'} came back as "no record filed"`}
        </p>
        <p className="text-sm text-blue-900 mt-1">
          Enroll this entity in monitoring and we&apos;ll re-pull the transcript on a cadence — the moment
          the IRS posts the missing return, you&apos;ll get a fresh transcript automatically. No-record-found
          pulls are <strong>not billed</strong>; only fresh-data pulls trigger the $59.98 charge.
        </p>
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex items-center px-3 py-1.5 bg-blue-600 text-white rounded text-xs font-semibold hover:bg-blue-700"
          >
            {wasCancelled ? 'Re-enroll in monitoring →' : 'Enroll in monitoring →'}
          </button>
          <span className="text-[11px] text-blue-800">
            $19.99 one-time enrollment · $59.98 per new transcript delivered
          </span>
        </div>
      </div>
    );
  }

  // ── Expanded form (collecting frequency) ──────────────────────────────
  return (
    <div className="mt-4 bg-white rounded border border-blue-300 p-4 max-w-2xl">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-bold text-mt-dark">Enroll in monitoring</p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[11px] text-gray-500 hover:text-gray-700"
        >
          cancel
        </button>
      </div>
      <p className="text-xs text-gray-600 mb-3">
        Pick how often we re-pull. Quarterly is the default — caught-up returns typically appear at the
        IRS 4–8 weeks after filing, so quarterly catches all but the most extreme delays without
        over-spending. Annual is good for portfolio sweeps on already-current borrowers.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        {(['weekly', 'monthly', 'quarterly', 'annual'] as Frequency[]).map((f) => {
          const isSelected = frequency === f;
          return (
            <label
              key={f}
              className={`block cursor-pointer rounded border p-3 text-center text-xs ${
                isSelected
                  ? 'bg-blue-50 border-blue-500 ring-1 ring-blue-500'
                  : 'bg-white border-gray-300 hover:border-blue-300'
              }`}
            >
              <input
                type="radio"
                name="frequency"
                value={f}
                checked={isSelected}
                onChange={() => setFrequency(f)}
                className="sr-only"
              />
              <p className="font-bold capitalize text-mt-dark">{f}</p>
              <p className="text-[11px] text-gray-500 mt-0.5">
                {f === 'weekly' && 'every 7 days'}
                {f === 'monthly' && 'every 30 days'}
                {f === 'quarterly' && 'every 90 days'}
                {f === 'annual' && 'every 365 days'}
              </p>
            </label>
          );
        })}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="inline-flex items-center px-3 py-1.5 bg-blue-600 text-white rounded text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending ? 'Enrolling…' : `Enroll · $19.99 now + $59.98/pull →`}
        </button>
        <span className="text-[10px] text-gray-600">
          First pull fires immediately — re-checks the missing periods today.
        </span>
      </div>
      {error && <p className="mt-2 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
