'use client';

/**
 * Self-serve pack purchase button — used on the public ERC sample
 * (/sample-transcripts/erc-report) and any other prospect-facing CTA.
 *
 * Calls /api/billing/self-serve-checkout (no auth) and redirects to
 * Stripe Checkout. After payment, Stripe sends the buyer to /welcome
 * and the webhook emails matt@moderntax.io with onboarding details.
 */

import { useState, useTransition } from 'react';
import type { SelfServePackId } from '@/lib/pricing';

interface Props {
  pack: SelfServePackId;
  /** Visible label on the button. */
  label: string;
  /** Optional CSS class for the button (defaults to a primary green). */
  className?: string;
}

export function SelfServePackButton({ pack, label, className }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/billing/self-serve-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pack }),
        });
        const data = await res.json();
        if (!res.ok || !data.url) {
          setError(data.error || 'Could not start checkout');
          return;
        }
        window.location.href = data.url;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      }
    });
  };

  const baseClass = className || 'inline-flex items-center gap-2 px-4 py-2 bg-mt-green text-white rounded-lg font-semibold hover:bg-mt-green/90 disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button type="button" onClick={submit} disabled={pending} className={baseClass}>
        {pending ? 'Starting checkout…' : label}
      </button>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
