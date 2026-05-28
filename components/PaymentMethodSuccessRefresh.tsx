'use client';

/**
 * PaymentMethodSuccessRefresh — auto-refreshes /payment-method after the
 * Stripe Checkout return when the saved card hasn't appeared yet.
 *
 * The checkout.session.completed webhook can take 1–5 seconds to fire +
 * persist the payment_method to the clients table. Without this, the user
 * lands on /payment-method?status=success and sees the green banner but no
 * card on file (because the page was rendered before the webhook completed).
 *
 * Behavior:
 *   - Only mounts when ?status=success is present AND no method is on file yet.
 *   - Soft-reloads every 2 seconds, up to 6 attempts (12s total).
 *   - Stops once a method appears OR after the cap.
 *   - Showing this component means the user already saw the green "Card
 *     saved" banner, so the spinner here just indicates "waiting for sync."
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  hasMethod: boolean;
}

export function PaymentMethodSuccessRefresh({ hasMethod }: Props) {
  const router = useRouter();
  const [attempts, setAttempts] = useState(0);
  const MAX_ATTEMPTS = 6;

  useEffect(() => {
    if (hasMethod) return;
    if (attempts >= MAX_ATTEMPTS) return;
    const t = setTimeout(() => {
      setAttempts(a => a + 1);
      router.refresh();
    }, 2000);
    return () => clearTimeout(t);
  }, [attempts, hasMethod, router]);

  if (hasMethod) return null;
  if (attempts >= MAX_ATTEMPTS) {
    return (
      <p className="mt-2 text-xs text-amber-700">
        Stripe is taking longer than expected to finalize. Reload this page in a minute, or email matt@moderntax.io if the card still isn&rsquo;t shown.
      </p>
    );
  }
  return (
    <p className="mt-2 text-xs text-emerald-700 inline-flex items-center gap-1.5">
      <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25"/>
        <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" className="opacity-75" fill="none"/>
      </svg>
      Waiting for Stripe to confirm… ({attempts + 1}/{MAX_ATTEMPTS})
    </p>
  );
}
