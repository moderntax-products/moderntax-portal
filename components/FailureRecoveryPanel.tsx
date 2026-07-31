'use client';

/**
 * Shown on a FAILED entity in the processor's request view. Explains why the
 * pull couldn't be completed — in plain language, and WITHOUT ever naming the
 * expert who worked it (the reason is read from expert_assignments.miss_reason
 * server-side, with no profiles join) — then gives the processor the two
 * recovery paths and a way to re-queue:
 *
 *   1. Update information (EditEntityButton → /api/entity/update)
 *   2. Upload a new signed 8821 (ReplaceSigned8821 → /api/entity/replace-8821,
 *      which re-queues on its own)
 *   3. Re-submit for another pull (/api/entity/resubmit → status 8821_signed,
 *      which the auto-assign cron re-picks)
 *
 * For a failed entity, the header Edit / 8821 panel / replace control are all
 * otherwise hidden, so this panel is the single place recovery happens.
 * Matt 2026-07-31 (Elena/BFC + Sonja/Cal Statewide: surface the reason, let the
 * processor fix it and retry without a support ticket).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { EditEntityButton } from './EditEntityButton';
import { ReplaceSigned8821 } from './ReplaceSigned8821';

interface Props {
  entityId: string;
  entityName: string;
  status: string;
  hasSigned8821: boolean;
  reason: { title: string; explanation: string; primaryFix: string };
  signerEmail: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
}

export function FailureRecoveryPanel({
  entityId,
  entityName,
  status,
  hasSigned8821,
  reason,
  signerEmail,
  address,
  city,
  state,
  zipCode,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/entity/resubmit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Could not re-submit this entity');
        return;
      }
      router.refresh(); // status → 8821_signed; this panel unmounts
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not re-submit');
    } finally {
      setBusy(false);
    }
  };

  const editHint = reason.primaryFix === 'edit';
  const uploadHint = reason.primaryFix === 'upload_8821';

  return (
    <div className="mb-4 rounded-lg border border-red-200 bg-red-50 overflow-hidden">
      <div className="px-4 py-3 border-b border-red-100">
        <div className="flex items-start gap-2.5">
          <svg className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div className="min-w-0">
            {/* The red panel + title already say "failed"; don't also prepend a
                fixed lead-in, which doubled up as "This pull couldn't be
                completed — This pull could not be completed" on the generic
                reason. The title alone reads clean for specific and generic. */}
            <p className="text-sm font-semibold text-red-800">{reason.title}</p>
            <p className="text-sm text-red-700 mt-0.5">{reason.explanation}</p>
          </div>
        </div>
      </div>

      <div className="bg-white px-4 py-4 space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Fix it and re-submit</p>

        {/* 1. Update information */}
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-full text-[11px] font-bold flex items-center justify-center ${editHint ? 'bg-mt-green text-white' : 'bg-gray-200 text-gray-600'}`}>1</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-800">
              Update the entity details {editHint && <span className="text-mt-green font-semibold">— recommended for this issue</span>}
            </p>
            <p className="text-xs text-gray-500 mb-1.5">Correct the signer email or address that the IRS rejected.</p>
            <EditEntityButton
              entityId={entityId}
              entityName={entityName}
              currentSignerEmail={signerEmail}
              currentAddress={address}
              currentCity={city}
              currentState={state}
              currentZipCode={zipCode}
              status={status}
            />
          </div>
        </div>

        {/* 2. Upload a new signed 8821 */}
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-full text-[11px] font-bold flex items-center justify-center ${uploadHint ? 'bg-mt-green text-white' : 'bg-gray-200 text-gray-600'}`}>2</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-800">
              Upload a corrected signed 8821 {uploadHint && <span className="text-mt-green font-semibold">— recommended for this issue</span>}
            </p>
            <p className="text-xs text-gray-500">Attaching a new signed 8821 re-queues this entity automatically.</p>
            <ReplaceSigned8821 entityId={entityId} entityName={entityName} hasExisting={hasSigned8821} />
          </div>
        </div>

        {/* 3. Re-submit */}
        <div className="flex items-start gap-3 border-t border-gray-100 pt-4">
          <span className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full text-[11px] font-bold flex items-center justify-center bg-gray-200 text-gray-600">3</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-800">Re-submit for another pull</p>
            <p className="text-xs text-gray-500 mb-2">
              Already corrected the details? Put it back in the queue.{' '}
              {!hasSigned8821 && <span className="text-amber-700">A signed 8821 must be on file first.</span>}
            </p>
            <button
              type="button"
              onClick={resubmit}
              disabled={busy || !hasSigned8821}
              title={!hasSigned8821 ? 'Upload a signed 8821 first' : undefined}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold bg-mt-green text-white hover:bg-opacity-90 disabled:opacity-50"
            >
              {busy ? 'Re-submitting…' : '⟳ Re-submit for another pull'}
            </button>
            {error && <p className="text-xs text-red-600 mt-1.5">{error}</p>}
          </div>
        </div>
      </div>

      <div className="px-4 py-2 bg-gray-50 border-t border-gray-100">
        <p className="text-[11px] text-gray-400">Flagged by the ModernTax processing team · need help? Use the support option below.</p>
      </div>
    </div>
  );
}
