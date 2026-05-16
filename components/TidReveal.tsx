'use client';

/**
 * TidReveal — admin-facing click-to-reveal TID component.
 *
 * SOC 2 C1.1 / P4.1 — SSN/EIN must NOT render in the clear by default.
 * Default rendering uses lib/mask.ts:maskTid(). Admin can click "show"
 * to reveal the full value when needed (e.g., before an IRS PPS call).
 *
 * TODO follow-up: emit an audit_log entry on each reveal so we have
 * per-user-per-record disclosure evidence for SOC 2 Type II observation.
 */

import { useState } from 'react';
import { maskTid } from '@/lib/mask';

interface Props {
  tid: string | null | undefined;
  kind?: string | null;
  /** Optional className for the value span (e.g., "font-mono text-sm"). */
  className?: string;
}

export function TidReveal({ tid, kind, className = '' }: Props) {
  const [shown, setShown] = useState(false);
  if (!tid) return <span className={className}>—</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <span className={className}>{shown ? tid : maskTid(tid, kind || undefined)}</span>
      <button
        type="button"
        onClick={() => setShown(s => !s)}
        className="text-indigo-600 hover:text-indigo-800 underline text-[10px]"
        aria-label={shown ? 'Hide tax ID' : 'Show tax ID'}
      >
        {shown ? 'hide' : 'show'}
      </button>
    </span>
  );
}
