'use client';

/**
 * Download8821Button — the single, shared "get a pre-filled 8821" control used
 * across EVERY ordering workflow (Manual, CSV/Excel, Bulk, Signed-PDF, Convert
 * Vendor). It generates a fully-populated Form 8821 (taxpayer info + ModernTax
 * house designee) from whatever order fields the flow has in memory, downloads
 * it, AND emails a copy to the ordering processor.
 *
 * Every flow names its fields differently (legalName vs entity_name vs
 * taxpayer_name, etc.), so each caller maps its own row shape onto these
 * normalized props. Keeping one component means the button, copy, and behavior
 * stay identical everywhere — the consistency the BFC demo asked for.
 *
 * Backed by POST /api/entity/8821-generate (processor/manager/admin).
 */

import { useState } from 'react';

export interface Download8821ButtonProps {
  entityName?: string;
  tid?: string;
  formType?: string;
  /** Accepts a year array (["2023","2024"]) or a raw string ("2023, 2024"). */
  years?: string | string[] | number[];
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  /** For post-order surfaces (e.g. the request page) — pulls stored data. */
  entityId?: string;
  /** Compact styling for table rows / dense layouts. */
  compact?: boolean;
  /** Override the button label (default "Download 8821"). */
  label?: string;
  disabled?: boolean;
}

function normalizeYears(years: Download8821ButtonProps['years']): string[] {
  if (!years) return [];
  if (Array.isArray(years)) return years.map((y) => String(y).trim()).filter(Boolean);
  return String(years).split(/[,\s]+/).map((y) => y.trim()).filter(Boolean);
}

export function Download8821Button(props: Download8821ButtonProps) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState<string>('');

  const handleClick = async () => {
    if (!props.entityId && (!props.entityName?.trim() || !props.tid?.trim())) {
      setStatus('error');
      setMsg('Enter the taxpayer name and TIN first.');
      return;
    }
    setStatus('loading');
    setMsg('');
    try {
      const body = props.entityId
        ? { entityId: props.entityId, email: true }
        : {
            entityName: props.entityName,
            tid: props.tid,
            formType: props.formType,
            years: normalizeYears(props.years),
            address: props.address,
            city: props.city,
            state: props.state,
            zipCode: props.zipCode,
            email: true,
          };
      const res = await fetch('/api/entity/8821-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.detail || 'Could not generate the 8821');

      const filename = data.filename || '8821.pdf';
      if (data.url) {
        const a = document.createElement('a');
        a.href = data.url;
        a.download = filename;
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else if (data.pdfBase64) {
        const bytes = Uint8Array.from(atob(data.pdfBase64), (c) => c.charCodeAt(0));
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      }
      setStatus('done');
      setMsg(data.emailed ? `Downloaded — also emailed to ${data.emailedTo}` : 'Downloaded');
    } catch (err) {
      setStatus('error');
      setMsg(err instanceof Error ? err.message : 'Failed to generate 8821');
    }
  };

  const label = status === 'loading'
    ? 'Generating…'
    : status === 'done'
      ? 'Download again'
      : (props.label || 'Download 8821');

  const btnClass = props.compact
    ? 'inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold bg-mt-green text-white rounded-md hover:bg-mt-green/90 transition-colors disabled:opacity-50 whitespace-nowrap'
    : 'inline-flex items-center gap-1.5 px-4 py-2 bg-mt-green text-white text-sm font-semibold rounded-lg hover:bg-mt-green/90 transition-colors disabled:opacity-50';

  return (
    <span className={props.compact ? 'inline-flex flex-col items-start gap-0.5' : 'inline-flex flex-col items-start gap-1'}>
      <button type="button" onClick={handleClick} disabled={props.disabled || status === 'loading'} className={btnClass}>
        <svg className={props.compact ? 'w-3 h-3' : 'w-4 h-4'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        {label}
      </button>
      {msg && (
        <span className={`text-[11px] font-medium ${status === 'error' ? 'text-red-500' : 'text-green-600'}`}>{msg}</span>
      )}
    </span>
  );
}
