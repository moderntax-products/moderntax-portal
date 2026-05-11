'use client';

/**
 * Upgrade-to-full-sweep button for the ERC report page.
 *
 * Shows on 941 entities that are still at the base tier (3 quarters).
 * On click, opens Stripe Checkout for PRICE_ERC_FULL_SWEEP_PREMIUM
 * ($79.98). On payment, the webhook flips
 * request_entities.erc_full_sweep_paid=true, the expert sees the
 * marker, and pulls the remaining quarters. The ERC report then
 * auto-includes them next time it's run.
 *
 * If the entity is already upgraded, renders a confirmation pill.
 */

import { useState, useTransition } from 'react';

interface Props {
  entityId: string;
  alreadyPaid: boolean;
  premiumPrice: number;
}

export function UpgradeToFullSweepButton({
  entityId,
  alreadyPaid,
  premiumPrice,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (alreadyPaid) {
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-emerald-50 border border-emerald-300 rounded text-xs font-semibold text-emerald-800">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        Full sweep enabled — all eligible quarters
      </div>
    );
  }

  const submit = () => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/billing/purchase', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'erc_full_sweep', entity_id: entityId }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Could not start checkout');
          return;
        }
        window.location.href = data.url;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      }
    });
  };

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={submit}
        disabled={pending}
        className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {pending ? 'Starting…' : `Upgrade to Full Sweep · +$${premiumPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
      </button>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
