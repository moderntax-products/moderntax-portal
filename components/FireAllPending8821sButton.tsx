'use client';

import { useEffect, useState } from 'react';

export interface FireAllPending8821sButtonProps {
  /** Optional: narrow to one client. Leave undefined for all clients. */
  clientId?: string;
  /** Optional label override. Default: "Fire all pending 8821s". */
  label?: string;
  /** Called after a successful bulk send with the API response body. */
  onSuccess?: (report: unknown) => void;
}

/**
 * One-click admin control that fires Dropbox Sign signature requests for
 * every entity that's currently eligible:
 *
 *   • signer_email populated
 *   • signature_id null
 *   • status not in (completed, cancelled, failed)
 *   • form_type != 'W2_INCOME'
 *
 * The live count is fetched on mount (and after each fire) via
 * GET /api/admin/send-pending-8821s — admin sees "Fire all pending 8821s (N)"
 * with a running total. Disabled when count = 0.
 *
 * Also supports a built-in two-step confirm: first click previews the count
 * and asks for confirmation, second click actually fires. Avoids accidentally
 * firing dozens of DocuSign-priced signature requests.
 */
export function FireAllPending8821sButton({
  clientId,
  label = 'Fire all pending 8821s',
  onSuccess,
}: FireAllPending8821sButtonProps) {
  const [pending, setPending] = useState<number | null>(null);
  const [state, setState] = useState<'idle' | 'confirming' | 'sending' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const qs = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';

  const refresh = async () => {
    try {
      const res = await fetch(`/api/admin/send-pending-8821s${qs}`);
      const body = await res.json();
      if (res.ok) setPending(body.pending ?? 0);
    } catch {
      /* best-effort — if refresh fails the button just shows stale count */
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  const fire = async () => {
    setState('sending');
    setMessage(null);
    try {
      const postQs = clientId
        ? `?scope=all&clientId=${encodeURIComponent(clientId)}`
        : '?scope=all';
      const res = await fetch(`/api/admin/send-pending-8821s${postQs}`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

      const sent = body.counts?.sent || 0;
      const skipped = Object.entries(body.counts || {})
        .filter(([k]) => k.startsWith('skip_'))
        .reduce((sum, [, v]) => sum + (v as number), 0);
      const failed = body.counts?.send_failed || 0;

      setState(failed > 0 && sent === 0 ? 'error' : 'done');
      setMessage(
        `Sent ${sent}${skipped > 0 ? ` · skipped ${skipped}` : ''}${failed > 0 ? ` · failed ${failed}` : ''}`,
      );
      onSuccess?.(body);
      // Refresh the count after a successful fire — what was pending should now be 0 (or near 0).
      refresh();
    } catch (err) {
      setState('error');
      setMessage(err instanceof Error ? err.message : 'Bulk send failed');
    }
  };

  const handleClick = () => {
    if (state === 'sending') return;
    if (state === 'confirming') {
      fire();
      return;
    }
    // Refresh count first so the confirm shows the latest number
    refresh().then(() => setState('confirming'));
  };

  const cancel = () => {
    setState('idle');
    setMessage(null);
  };

  const count = pending ?? 0;
  const busy = state === 'sending';
  const disabled = busy || (state === 'idle' && count === 0);

  let buttonText: string;
  let colorClass: string;
  if (busy) {
    buttonText = 'Sending…';
    colorClass = 'bg-indigo-400 text-white';
  } else if (state === 'confirming') {
    buttonText = `Confirm — fire ${count} now`;
    colorClass = 'bg-red-600 text-white hover:bg-red-700';
  } else if (state === 'done') {
    buttonText = '✓ Sent';
    colorClass = 'bg-green-100 text-green-700 border border-green-300';
  } else if (state === 'error') {
    buttonText = 'Failed — retry';
    colorClass = 'bg-red-100 text-red-700 border border-red-300';
  } else {
    buttonText = count > 0 ? `${label} (${count})` : `${label} (0)`;
    colorClass = count === 0
      ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
      : 'bg-indigo-600 text-white hover:bg-indigo-700';
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <div className="inline-flex items-center gap-2">
        <button
          onClick={handleClick}
          disabled={disabled}
          className={`px-4 py-2 text-sm font-semibold rounded-lg whitespace-nowrap ${colorClass}`}
        >
          {buttonText}
        </button>
        {state === 'confirming' && (
          <button
            onClick={cancel}
            className="px-3 py-2 text-xs text-gray-600 hover:text-gray-800"
          >
            Cancel
          </button>
        )}
      </div>
      {state === 'confirming' && (
        <p className="text-[11px] text-gray-600">
          This will send {count} Dropbox Sign signature request{count === 1 ? '' : 's'} immediately.
          Each consumes one Dropbox Sign request credit. Click confirm to proceed.
        </p>
      )}
      {message && state !== 'confirming' && (
        <span className={`text-[11px] ${state === 'error' ? 'text-red-600' : 'text-gray-600'}`}>
          {message}
        </span>
      )}
    </div>
  );
}
