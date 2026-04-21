'use client';

import { useState } from 'react';

export interface Send8821ButtonProps {
  /** Fire for one specific entity. */
  entityId?: string;
  /** Or fire for every pending entity on a request (bulk). */
  requestId?: string;
  /** Display name shown in the button / status text. */
  label?: string;
  /**
   * Gating info — when `disabled` is true the button renders as a greyed-out
   * pill with an explanation tooltip. The admin can still see *why* it's
   * disabled (no signer email, already signed, etc.) without hovering the
   * underlying entity row.
   */
  disabled?: boolean;
  disabledReason?: string;
  /** Optional: callback after a successful send — caller typically reloads page. */
  onSuccess?: (report: unknown) => void;
}

/**
 * Admin button that triggers Dropbox Sign signature requests for one entity
 * (entityId) or all pending entities on a request (requestId).
 *
 * Calls POST /api/admin/send-pending-8821s which performs the skip logic
 * server-side (skips entities that already have signature_id, are completed,
 * are W2_INCOME, or have no signer_email).
 */
export function Send8821Button({
  entityId,
  requestId,
  label = 'Send 8821 via Dropbox Sign',
  disabled,
  disabledReason,
  onSuccess,
}: Send8821ButtonProps) {
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const handleClick = async () => {
    if (disabled || state === 'sending') return;
    setState('sending');
    setMessage(null);
    try {
      const qs = entityId
        ? `entityId=${encodeURIComponent(entityId)}`
        : `requestId=${encodeURIComponent(requestId!)}`;
      const res = await fetch(`/api/admin/send-pending-8821s?${qs}`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

      const sentCount = body.counts?.sent || 0;
      const skipped = Object.entries(body.counts || {})
        .filter(([k]) => k.startsWith('skip_'))
        .reduce((sum, [, v]) => sum + (v as number), 0);
      const failed = body.counts?.send_failed || 0;

      const summary = entityId
        ? (sentCount > 0 ? 'Sent.' : failed > 0 ? `Failed: ${body.details?.[0]?.error || 'unknown'}` : `Skipped: ${body.details?.[0]?.result || 'unknown'}`)
        : `Sent ${sentCount}${skipped > 0 ? `, skipped ${skipped}` : ''}${failed > 0 ? `, failed ${failed}` : ''}`;

      setState(failed > 0 && sentCount === 0 ? 'error' : 'done');
      setMessage(summary);
      onSuccess?.(body);
    } catch (err) {
      setState('error');
      setMessage(err instanceof Error ? err.message : 'Send failed');
    }
  };

  if (disabled) {
    return (
      <div className="inline-flex flex-col">
        <button
          disabled
          title={disabledReason}
          className="px-3 py-1.5 text-xs font-medium bg-gray-100 text-gray-400 rounded-lg cursor-not-allowed whitespace-nowrap"
        >
          {label}
        </button>
        {disabledReason && <span className="text-[10px] text-gray-400 mt-0.5">{disabledReason}</span>}
      </div>
    );
  }

  const busy = state === 'sending';
  const colorClass =
    state === 'done' ? 'bg-green-100 text-green-700 border border-green-300'
    : state === 'error' ? 'bg-red-100 text-red-700 border border-red-300'
    : 'bg-indigo-600 text-white hover:bg-indigo-700';

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        onClick={handleClick}
        disabled={busy || state === 'done'}
        className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap disabled:opacity-60 ${colorClass}`}
      >
        {busy ? 'Sending…' : state === 'done' ? '✓ Sent' : label}
      </button>
      {message && (
        <span className={`text-[11px] ${state === 'error' ? 'text-red-600' : 'text-gray-600'}`}>
          {message}
        </span>
      )}
    </div>
  );
}
