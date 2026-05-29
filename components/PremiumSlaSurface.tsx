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
 * Drop this into the dashboard top-right or the request detail page
 * header. Reads sla_tier off the user's profile.client config.
 */

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';

type Tier = 'standard' | 'premium' | null;

export function PremiumSlaSurface({ variant = 'inline' }: { variant?: 'inline' | 'banner' }) {
  const [tier, setTier] = useState<Tier>(null);
  const [requested, setRequested] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const sb = createClient();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      const { data: profile } = await sb.from('profiles')
        .select('client_id').eq('id', user.id).single() as { data: { client_id: string | null } | null };
      if (!profile?.client_id) return;
      const { data: client } = await sb.from('clients')
        .select('sla_tier, sla_tier_requested_at').eq('id', profile.client_id).single() as { data: { sla_tier: Tier; sla_tier_requested_at: string | null } | null };
      if (client) {
        setTier(client.sla_tier);
        if (client.sla_tier_requested_at) setRequested(true);
      }
    })().catch(() => {/* silent — pre-migration */});
  }, []);

  const handleUpgrade = async () => {
    setSubmitting(true);
    setMessage(null);
    try {
      const res = await fetch('/api/billing/request-premium-sla', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setRequested(true);
        setMessage(data.message || 'Upgrade requested — we\'ll be in touch.');
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
