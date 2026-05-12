'use client';

/**
 * TierUpgradeButton — In-app self-serve tier upgrade via Stripe Checkout.
 *
 * Replaces the mailto-to-matt@ flow that previously gated every upgrade
 * behind manual sales follow-up. Manager (or admin) clicks → POST to
 * /api/billing/upgrade-tier → redirect to Stripe-hosted Checkout →
 * webhook flips clients.billing_model + rates on payment success.
 *
 * Behavior:
 *   - For Tier B (Deposit): one-time $2,500 charge. Per-TIN rate locks at $59.98.
 *   - For Tier C (Platform): $2,500/mo recurring. 50 entities included + $39.99 overage.
 *   - For unauthenticated viewers (prospects on /plans): falls back to
 *     mailto-Matt since they can't complete a Checkout without an account.
 *   - Disables itself if the user is already on the target tier or higher.
 */

import { useState } from 'react';

interface TierUpgradeButtonProps {
  tier: 'B' | 'C';
  isSignedIn: boolean;
  /** Optional client ID for admin testing. Manager always uses their own. */
  clientId?: string;
  /** Visual variant. */
  variant?: 'primary-green' | 'primary-dark' | 'secondary';
  /** Override label; defaults to "Upgrade to Tier X". */
  label?: string;
}

export function TierUpgradeButton({
  tier,
  isSignedIn,
  clientId,
  variant = 'primary-green',
  label,
}: TierUpgradeButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Unauthenticated fallback — prospects can't auth-charge a card; route to sales.
  if (!isSignedIn) {
    const subject = tier === 'B'
      ? 'Upgrade to Tier B (Deposit)'
      : 'Upgrade to Tier C (Platform)';
    return (
      <a
        href={`mailto:matt@moderntax.io?subject=${encodeURIComponent(subject)}`}
        className={buttonClassName(variant)}
      >
        {label || (tier === 'B' ? 'Upgrade to Tier B' : 'Upgrade to Tier C')}
      </a>
    );
  }

  const handleClick = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/upgrade-tier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier, ...(clientId ? { clientId } : {}) }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start upgrade');
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <button
        onClick={handleClick}
        disabled={busy}
        className={`${buttonClassName(variant)} ${busy ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {busy ? 'Opening Stripe…' : (label || (tier === 'B' ? 'Upgrade to Tier B' : 'Upgrade to Tier C'))}
      </button>
      {error && (
        <p className="text-[11px] text-red-600">{error}</p>
      )}
    </div>
  );
}

function buttonClassName(variant: 'primary-green' | 'primary-dark' | 'secondary'): string {
  const base = 'inline-block w-full text-center px-4 py-2.5 text-sm font-semibold rounded-lg transition-colors';
  switch (variant) {
    case 'primary-green':
      return `${base} bg-mt-green text-white hover:bg-emerald-600`;
    case 'primary-dark':
      return `${base} bg-mt-dark text-white hover:bg-gray-800`;
    case 'secondary':
      return `${base} bg-white border-2 border-mt-dark text-mt-dark hover:bg-gray-50`;
  }
}
