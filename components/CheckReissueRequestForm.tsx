'use client';

/**
 * Public, no-auth check-reissue request form. Lives on the ERC sample
 * (/sample-transcripts/erc-report) inside the action-items panel for
 * quarters where the refund check came back undelivered.
 *
 * Flow:
 *   1. Anonymous prospect clicks "Request Check Reissue · $1,000 (Mercury ACH)"
 *   2. Inline form expands asking for email + business name (and optional
 *      EIN / notes). Refund quarter + amount are pre-filled from the sample.
 *   3. Submit → POST /api/billing/check-reissue-request → emails Matt
 *   4. Confirmation message shown in place of the form
 *
 * No portal account is created — this is intentional. The customer pays
 * via Mercury ACH (manual invoice from Matt) and we onboard them
 * off-platform once payment lands.
 */

import { useState, useTransition } from 'react';

interface Props {
  /** Pre-filled context surfaced from the ERC report row. */
  prefill?: {
    refundQuarter?: string;     // e.g. "2020 Q4"
    refundAmount?: number;      // dollars
  };
  /** Visible label on the trigger button. */
  label?: string;
  /** Optional CSS class for the trigger button. */
  triggerClassName?: string;
}

export function CheckReissueRequestForm({ prefill, label, triggerClassName }: Props) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [ein, setEin] = useState('');
  const [notes, setNotes] = useState('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  const triggerClass =
    triggerClassName ||
    'inline-flex items-center gap-2 px-3 py-1.5 bg-amber-600 text-white rounded text-xs font-semibold hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed';

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/billing/check-reissue-request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email.trim(),
            businessName: businessName.trim(),
            ein: ein.trim() || undefined,
            refundQuarter: prefill?.refundQuarter,
            refundAmount: prefill?.refundAmount,
            notes: notes.trim() || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Could not submit request');
          return;
        }
        setConfirmation(
          data.message ||
            `Thanks — we'll send a Mercury ACH invoice for $1,000 to ${email.trim()} within 1 business day.`,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      }
    });
  };

  if (confirmation) {
    return (
      <div className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 max-w-md">
        <div className="flex items-start gap-2">
          <svg className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <div>
            <p className="font-semibold">Request received — Mercury ACH invoice incoming</p>
            <p className="mt-1 text-emerald-800">{confirmation}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={triggerClass}>
        {label || 'Request Check Reissue · $1,000 (Mercury ACH)'}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="rounded border border-amber-300 bg-white px-4 py-3 max-w-lg w-full text-xs">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-semibold text-amber-900">
          Request Check Reissue · $1,000 (Mercury ACH invoice)
        </p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[11px] text-gray-500 hover:text-gray-700"
        >
          cancel
        </button>
      </div>
      <p className="text-[11px] text-gray-600 mb-3">
        We&apos;ll send you a Mercury ACH invoice for $1,000. Once paid, we file Form 8822-B
        and call the IRS Business &amp; Specialty Tax line to recover the check.
        {prefill?.refundQuarter && (
          <> Pre-filled context: <strong>{prefill.refundQuarter}</strong>
            {prefill.refundAmount ? ` · $${prefill.refundAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} returned` : ''}.
          </>
        )}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
        <label className="block">
          <span className="text-[11px] font-medium text-gray-700">Email *</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@firm.com"
            className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-mt-green focus:ring-1 focus:ring-mt-green"
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-medium text-gray-700">Business name *</span>
          <input
            type="text"
            required
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="Acme Tax Services LLC"
            className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-mt-green focus:ring-1 focus:ring-mt-green"
          />
        </label>
      </div>

      <label className="block mb-2">
        <span className="text-[11px] font-medium text-gray-700">Client EIN (optional)</span>
        <input
          type="text"
          value={ein}
          onChange={(e) => setEin(e.target.value)}
          placeholder="12-3456789"
          className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-mt-green focus:ring-1 focus:ring-mt-green"
        />
      </label>

      <label className="block mb-3">
        <span className="text-[11px] font-medium text-gray-700">Notes (optional)</span>
        <textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. mailing address has changed, multiple checks involved, etc."
          className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-mt-green focus:ring-1 focus:ring-mt-green"
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center px-3 py-1.5 bg-amber-600 text-white rounded text-xs font-semibold hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending ? 'Submitting…' : 'Send my request →'}
        </button>
        <span className="text-[10px] text-gray-500">
          We&apos;ll email you the Mercury invoice within 1 business day.
        </span>
      </div>
      {error && <p className="mt-2 text-[11px] text-red-600">{error}</p>}
    </form>
  );
}
