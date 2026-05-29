'use client';

/**
 * PremiumSlaSurface — renders the Premium SLA badge for accounts on the
 * premium tier, OR the upgrade CTA for accounts on standard tier.
 *
 * Driver: 2026-05-28 Matt — productize the same-day SLA tier. Cal
 * Statewide is the first paying premium account. Trial accounts get the
 * upgrade CTA on their dashboard so they convert from speed-curious to
 * paying.
 *
 * 2026-05-29 refactor: tier is now passed as a PROP (server-rendered)
 * instead of fetched client-side. The original client-side fetch could
 * fail silently when:
 *   - sla_tier column wasn't migrated yet (now it is)
 *   - Anon-client RLS blocked the clients table read
 *   - The select referenced a column that didn't exist
 *     (sla_tier_requested_at was selected but never created)
 * Server-rendering via the admin client makes this rock-solid: any
 * authenticated user with a real client_id sees the right state.
 */

import { useState } from 'react';

export interface PremiumSlaSurfaceProps {
  /**
   * The client's current SLA tier. Server-rendered from the auto-invoice
   * cron's data source. Pass null when the migration hasn't been applied
   * yet — the component renders nothing in that case (fail-quiet).
   */
  tier: 'standard' | 'premium' | null;
  variant?: 'inline' | 'banner';
}

export function PremiumSlaSurface({ tier, variant = 'inline' }: PremiumSlaSurfaceProps) {
  const [requested, setRequested] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleUpgrade = async () => {
    setSubmitting(true);
    setMessage(null);
    try {
      const res = await fetch('/api/billing/request-premium-sla', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setRequested(true);
        setMessage(data.message || 'Upgrade requested — we will be in touch.');
      } else {
        setMessage(data.error || 'Something went wrong.');
      }
    } catch (err: any) {
      setMessage(err?.message || 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  if (tier === null) return null; // pre-migration / unknown — render nothing

  // PREMIUM BADGE
  if (tier === 'premium') {
    if (variant === 'banner') {
      return (
        <div className="bg-gradient-to-r from-violet-50 to-indigo-50 border border-violet-200 rounded-lg p-3 flex items-center gap-3">
          <span className="text-2xl">⚡</span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-violet-900">Premium SLA active</p>
            <p className="text-xs text-violet-700">Same-day turnaround target · expert-routing priority · dedicated SLA monitoring</p>
          </div>
        </div>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-violet-100 text-violet-800" title="Premium SLA: same-day target, expert-routing priority">
        ⚡ Premium SLA
      </span>
    );
  }

  // STANDARD — show upgrade CTA
  if (requested) {
    return (
      <div className="border border-amber-200 bg-amber-50 rounded-lg p-3 text-xs text-amber-900">
        <p className="font-semibold mb-0.5">⏳ Premium SLA upgrade requested</p>
        <p>We&apos;ll confirm within 24h. Standard 24-48h turnaround remains active in the meantime.</p>
      </div>
    );
  }

  if (variant === 'banner') {
    return (
      <div className="border border-violet-200 bg-violet-50 rounded-lg p-4 flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">⚡</span>
            <h3 className="font-semibold text-violet-900">Premium SLA — same-day turnaround</h3>
          </div>
          <p className="text-sm text-violet-800">
            Upgrade your account to guaranteed same-day target on every transcript pull, expert-routing priority on the assignment queue, and a Premium SLA badge across your customer-facing surfaces.
          </p>
          {message && <p className="text-xs text-violet-700 mt-2">{message}</p>}
        </div>
        <button
          onClick={handleUpgrade}
          disabled={submitting}
          className="px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-60 text-white text-sm font-semibold rounded-lg whitespace-nowrap transition-colors"
        >
          {submitting ? 'Requesting…' : 'Upgrade to Premium SLA'}
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={handleUpgrade}
      disabled={submitting}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-violet-100 hover:bg-violet-200 text-violet-800 disabled:opacity-60 transition-colors"
      title="Upgrade to Premium SLA — same-day target + expert-routing priority"
    >
      ⚡ {submitting ? 'Requesting…' : 'Upgrade to Premium SLA'}
    </button>
  );
}
