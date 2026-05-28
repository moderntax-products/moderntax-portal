'use client';

/**
 * CashFlowPackButton — generate the SBA Cash-Flow Analysis Pack for a single
 * entity. Two states:
 *
 *   1. No pack yet → "Generate Cash-Flow Pack ($49.99)" — confirms then POSTs
 *      to /api/cash-flow/generate. On success, switches to "Download" state.
 *   2. Pack exists → "Download Cash-Flow Pack" — opens the stored PDF.
 *
 * Surfacing rules (caller decides via props):
 *   - Show only on entities with status='completed'
 *   - Skip W2_INCOME entities (no cash flow data on W&I transcripts)
 *   - Skip entities with empty financials (button still shows but server
 *     will return skipped → component shows a friendly "no data" message)
 *
 * Pricing: $49.99/pack, billed via the next monthly auto-invoice run.
 * Re-running within 30 days re-serves the existing PDF (no re-charge).
 */

import { useState } from 'react';
import { createClient } from '@/lib/supabase';

interface CashFlowPackButtonProps {
  entityId: string;
  entityName: string;
  /** Optional — when provided, button skips the generate step and just opens the existing PDF. */
  existingPackUrl?: string | null;
  /** Years covered by the existing pack (for label display). */
  existingPackYears?: number;
  /** Compact layout (e.g. embedded in entity row). */
  compact?: boolean;
}

const PRICE = 49.99;

export function CashFlowPackButton({
  entityId,
  entityName,
  existingPackUrl,
  existingPackYears,
  compact = false,
}: CashFlowPackButtonProps) {
  const [state, setState] = useState<'idle' | 'confirming' | 'generating' | 'done' | 'error'>('idle');
  const [pdfUrl, setPdfUrl] = useState<string | null>(existingPackUrl || null);
  const [yearsCovered, setYearsCovered] = useState<number>(existingPackYears || 0);
  const [message, setMessage] = useState<string | null>(null);

  const handleGenerate = async () => {
    setState('generating');
    setMessage(null);
    try {
      const res = await fetch('/api/cash-flow/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (body.generated === 0 && body.skippedDetails?.[0]?.reason === 'no_financials_extracted') {
        setState('error');
        setMessage('No financials extracted from this entity\'s transcripts yet. Pull a Record of Account or Return Transcript first.');
        return;
      }
      const pdf = body.pdfs?.[0];
      if (pdf) {
        setPdfUrl(pdf.pdfUrl);
        setYearsCovered(pdf.yearsCovered);
        setState('done');
        setMessage(pdf.reused ? 'Re-served existing pack (no new charge — within 30-day window)' : `Generated · ${pdf.yearsCovered}-year pack · $${PRICE.toFixed(2)} added to next invoice`);
      } else {
        setState('error');
        setMessage('No PDF returned');
      }
    } catch (err) {
      setState('error');
      setMessage(err instanceof Error ? err.message : 'Generate failed');
    }
  };

  const handleDownload = async () => {
    if (!pdfUrl) return;
    // Use a signed URL via the storage API to download
    const supabase = createClient();
    const { data, error } = await supabase.storage.from('uploads').createSignedUrl(pdfUrl, 60);
    if (error || !data?.signedUrl) {
      setState('error');
      setMessage('Failed to generate download link');
      return;
    }
    window.open(data.signedUrl, '_blank');
  };

  // -- Existing pack: just download
  if (pdfUrl && state !== 'generating') {
    return (
      <div className={compact ? 'inline-flex items-center gap-2' : 'space-y-1'}>
        <button
          onClick={handleDownload}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-emerald-50 border border-emerald-300 text-emerald-800 rounded hover:bg-emerald-100"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Cash-Flow Pack {yearsCovered > 0 ? `(${yearsCovered}-yr)` : ''}
        </button>
        {state === 'done' && message && (
          <p className="text-[11px] text-emerald-700">{message}</p>
        )}
        {state === 'error' && message && (
          <p className="text-[11px] text-red-600">{message}</p>
        )}
      </div>
    );
  }

  // -- New generation flow
  if (state === 'confirming') {
    return (
      <div className={compact ? 'inline-flex items-center gap-2' : 'space-y-1'}>
        <button
          onClick={handleGenerate}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-mt-green text-white rounded hover:bg-emerald-600"
        >
          Confirm — generate (${PRICE.toFixed(2)})
        </button>
        <button
          onClick={() => { setState('idle'); setMessage(null); }}
          className="px-2 py-1.5 text-xs text-gray-600 hover:text-gray-800"
        >
          Cancel
        </button>
        <p className="text-[11px] text-gray-600">
          Adds ${PRICE.toFixed(2)} to {entityName}&rsquo;s next invoice line.
        </p>
      </div>
    );
  }

  return (
    <div className={compact ? 'inline-flex items-center gap-2' : 'space-y-1'}>
      <button
        onClick={() => setState('confirming')}
        disabled={state === 'generating'}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-white border border-mt-green text-mt-green rounded hover:bg-emerald-50 disabled:opacity-50"
      >
        {state === 'generating' ? 'Generating…' : `+ Cash-Flow Pack ($${PRICE.toFixed(2)})`}
      </button>
      {state === 'error' && message && (
        <p className="text-[11px] text-red-600">{message}</p>
      )}
      {!compact && state === 'idle' && (
        <p className="text-[11px] text-gray-500">
          SBA-format 3-year cash-flow worksheet from this entity&rsquo;s transcripts. Saves your underwriter ~30 min of Excel rekey.
        </p>
      )}
    </div>
  );
}
