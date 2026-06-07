'use client';

/**
 * Buy-credits popup for the billing page. Standard-plan clients pre-buy a
 * prepaid credit wallet; buying a pack also saves the card on file (the
 * Stripe Checkout uses setup_future_usage). Two tiers:
 *   - $1,000 → $59.99/request (40% off)
 *   - $2,000 → $39.99/request (60% off)
 */

import { useState } from 'react';

const PACKS = [
  { id: 'credits-1000', amount: 1000, rate: 59.99, discount: 40 },
  { id: 'credits-2000', amount: 2000, rate: 39.99, discount: 60 },
] as const;

const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function BuyCreditsModal({
  currentBalance = null,
  currentRate = null,
  triggerLabel = 'Add card & buy credits',
  triggerClassName,
}: {
  currentBalance?: number | null;
  currentRate?: number | null;
  triggerLabel?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const buy = async (packId: string) => {
    setLoading(packId);
    setError(null);
    try {
      const res = await fetch('/api/billing/buy-credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pack: packId }),
      });
      const data = await res.json();
      if (res.ok && data.url) {
        window.location.href = data.url; // Stripe Checkout
      } else {
        setError(data.error || 'Could not start checkout');
        setLoading(null);
      }
    } catch (e: any) {
      setError(e?.message || 'Request failed');
      setLoading(null);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={triggerClassName || 'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-mt-green text-white text-sm font-semibold hover:bg-opacity-90'}
      >
        💳 {triggerLabel}
      </button>

      {open && (
        <div className="fixed inset-0 z-[70] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-mt-dark">Buy transcript credits</h2>
                <p className="text-sm text-gray-600 mt-1">
                  Pre-buy credits to unlock a lower per-request rate. Checking out also saves your card on file (required to order).
                </p>
              </div>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>

            {(currentBalance !== null) && (
              <div className="mt-3 text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2">
                Current balance: <strong>{fmt(currentBalance)}</strong>
                {currentRate ? <> · your rate: <strong>{fmt(currentRate)}/request</strong></> : null}
              </div>
            )}

            <div className="mt-4 grid sm:grid-cols-2 gap-3">
              {PACKS.map((p) => (
                <div key={p.id} className="border border-gray-200 rounded-xl p-4 flex flex-col">
                  <div className="text-2xl font-bold text-mt-dark">{fmt(p.amount)}</div>
                  <div className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 rounded px-2 py-0.5 w-fit">
                    {p.discount}% off
                  </div>
                  <p className="text-sm text-gray-600 mt-2 flex-1">
                    Requests at <strong>{fmt(p.rate)}</strong> each (vs $99.99 standard) — about <strong>{Math.floor(p.amount / p.rate)}</strong> requests.
                  </p>
                  <button
                    onClick={() => buy(p.id)}
                    disabled={!!loading}
                    className="mt-3 w-full bg-mt-green text-white py-2 rounded-lg text-sm font-semibold hover:bg-opacity-90 disabled:opacity-50"
                  >
                    {loading === p.id ? 'Starting…' : `Buy ${fmt(p.amount)}`}
                  </button>
                </div>
              ))}
            </div>

            {error && <p className="text-xs text-red-600 mt-3">{error}</p>}
            <p className="text-[11px] text-gray-400 mt-4">Secure payment via Stripe. Credits never expire. The minimum purchase is $1,000.</p>
          </div>
        </div>
      )}
    </>
  );
}
