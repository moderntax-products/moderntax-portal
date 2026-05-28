'use client';

/**
 * PaymentMethodForm — single-button card-attach via Stripe Checkout.
 *
 * Why Checkout instead of inline Elements:
 *   PaymentElement requires every payment_method_type in the SetupIntent to
 *   have its corresponding Stripe configuration (Financial Connections for
 *   ACH, Apple Pay domains for Apple Pay, etc.). Without all of them
 *   configured, PaymentElement silently stalls. Hosted Checkout sidesteps
 *   the whole class of issues — Stripe renders only what's actually
 *   configured on the account.
 *
 * Flow:
 *   1. User clicks "Add card via Stripe →"
 *   2. POST /api/billing/checkout-session → returns { url }
 *   3. window.location.href = url   (redirect to Stripe-hosted page)
 *   4. User enters card on Stripe, submits
 *   5. Stripe redirects to /payment-method?status=success&session_id=cs_xxx
 *   6. Stripe webhook fires checkout.session.completed → server saves
 *      payment_method to clients table
 *   7. /payment-method success view shows the saved card
 *
 * Architecture (per Matt May 2026 split):
 *   • Stripe (card)  → upgrades, in-app add-on purchases, monitoring upsells
 *   • Mercury (ACH)  → monthly usage invoices + $2,500/mo platform fees
 *
 * ACH-via-Stripe is intentionally OFF — Mercury already owns ACH separately.
 */

import { useState } from 'react';

interface PaymentMethodFormProps {
  hasExisting: boolean;
  /** Admin override: which client to attach the payment method to. */
  clientId?: string;
}

export function PaymentMethodForm({ hasExisting, clientId }: PaymentMethodFormProps) {
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    setRedirecting(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clientId ? { clientId } : {}),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      // Hard redirect — Stripe Checkout takes over the browser.
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open Stripe Checkout');
      setRedirecting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-xs text-blue-900 leading-relaxed">
        Cards are processed by Stripe. You&rsquo;ll be redirected to Stripe&rsquo;s secure page to enter your card,
        then sent back here when you&rsquo;re done. ModernTax never sees the full card number.
      </div>

      <button
        onClick={handleClick}
        disabled={redirecting}
        className="w-full px-4 py-3 text-sm font-semibold bg-mt-green text-white rounded-lg hover:bg-emerald-600 disabled:opacity-50 inline-flex items-center justify-center gap-2"
      >
        {redirecting ? (
          <>
            <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25"/>
              <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" className="opacity-75" fill="none"/>
            </svg>
            Opening Stripe…
          </>
        ) : (
          <>
            {hasExisting ? 'Replace card via Stripe →' : 'Add card via Stripe →'}
          </>
        )}
      </button>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-700">
          <strong>Could not open Stripe Checkout:</strong> {error}
        </div>
      )}

      <p className="text-[11px] text-gray-500 text-center leading-relaxed">
        Authorizing this card lets ModernTax charge it for tier upgrades, add-on purchases (cash-flow pack, monitoring),
        and other in-app one-time charges. Monthly usage invoices remain on Mercury (ACH).
      </p>

      <div className="text-[11px] text-gray-400 text-center pt-2 border-t border-gray-100">
        ACH bank account?{' '}
        <a href="mailto:matt@moderntax.io?subject=Set%20up%20ACH%20billing%20via%20Mercury" className="underline">
          Email matt@moderntax.io
        </a>{' '}
        to set up Mercury ACH for monthly invoices.
      </div>
    </div>
  );
}
