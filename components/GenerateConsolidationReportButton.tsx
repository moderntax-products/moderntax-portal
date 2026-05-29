'use client';

/**
 * Admin button on /admin/requests/[id] — triggers
 * /api/admin/generate-consolidation-report and opens the resulting PDF.
 *
 * Defaults to mode='demo' (free). Held-CTRL/CMD on click flips to
 * mode='paid' which stamps the billing add-on. Confirms before billing.
 */

import { useState } from 'react';

export function GenerateConsolidationReportButton({ requestId, loanNumber, entityCount }: {
  requestId: string;
  loanNumber: string | null;
  entityCount: number;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [lastUrl, setLastUrl] = useState<string | null>(null);

  const generate = async (mode: 'demo' | 'paid') => {
    if (mode === 'paid') {
      const ok = confirm(`Generate the Loan-Package Consolidation Report and BILL the customer $99 for loan ${loanNumber || requestId.slice(0,8)}?\n\nClick OK to bill, Cancel to abort.`);
      if (!ok) return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/generate-consolidation-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: requestId, mode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error || 'Generation failed');
        return;
      }
      if (data.warning) setMessage(`⚠ ${data.warning}`);
      else setMessage(`✓ Generated (${data.billing}). PDF link valid for 1 hour.`);
      setLastUrl(data.signed_url || null);
      if (data.signed_url) window.open(data.signed_url, '_blank', 'noopener,noreferrer');
    } catch (err: any) {
      setMessage(err?.message || 'Network error');
    } finally {
      setBusy(false);
    }
  };

  if (entityCount < 2) {
    return (
      <div className="text-xs text-gray-500 italic">
        Consolidation report not available — needs at least 2 entities on the loan.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => generate('demo')}
          disabled={busy}
          className="px-3 py-1.5 text-xs font-medium bg-violet-600 text-white rounded hover:bg-violet-700 disabled:opacity-60 whitespace-nowrap"
          title="Generates the loan consolidation PDF for free (no customer charge). Use for demos + previews."
        >
          {busy ? 'Generating…' : '📑 Generate (demo — free)'}
        </button>
        <button
          type="button"
          onClick={() => generate('paid')}
          disabled={busy}
          className="px-3 py-1.5 text-xs font-medium bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-60 whitespace-nowrap"
          title="Generates the PDF AND stamps the $99 billing add-on. The customer will be charged at month-end."
        >
          {busy ? '…' : '💵 Generate + bill $99'}
        </button>
        {lastUrl && (
          <a
            href={lastUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-blue-700 hover:text-blue-900 underline"
          >
            Re-open last PDF
          </a>
        )}
      </div>
      {message && (
        <p className="text-xs text-gray-700">{message}</p>
      )}
    </div>
  );
}
