'use client';

import { useState } from 'react';

/**
 * Two-tier prepay CTA for the token-gated review page (/review/[token]).
 * Standard vs. Expedited (rush). Clicking POSTs to the no-login prepay endpoint
 * and forwards the taxpayer to Stripe Checkout. No PII is handled here — the
 * server derives the amount from the entity + the signed token.
 */
export function FilingPrepayCTA({
  token,
  standardTotal,
  expeditedTotal,
  yearCount,
}: {
  token: string;
  standardTotal: number;
  expeditedTotal: number;
  yearCount: number;
}) {
  const [loading, setLoading] = useState<null | 'standard' | 'expedited'>(null);
  const [error, setError] = useState<string | null>(null);

  const go = async (expedited: boolean) => {
    setError(null);
    setLoading(expedited ? 'expedited' : 'standard');
    try {
      const r = await fetch(`/api/public/filing-prepay/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expedited }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.url) {
        setError(j.error || 'Could not start checkout. Please try again.');
        setLoading(null);
        return;
      }
      window.location.href = j.url;
    } catch {
      setError('Network error — please try again.');
      setLoading(null);
    }
  };

  const money = (n: number) => `$${n.toFixed(2)}`;

  return (
    <div style={{ margin: '18px 0' }}>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {/* Standard */}
        <div style={cardStyle}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Standard</div>
          <div style={{ color: '#5e554b', fontSize: 13.5, margin: '4px 0 10px' }}>
            Get started in the normal queue. We prepare all {yearCount} returns; your
            expert confirms the full quote after the review call.
          </div>
          <div style={{ fontWeight: 700, fontSize: 22 }}>{money(standardTotal)}</div>
          <div style={{ color: '#5e554b', fontSize: 12 }}>starting deposit</div>
          <button onClick={() => go(false)} disabled={loading !== null} style={btnStyle(false, loading === 'standard')}>
            {loading === 'standard' ? 'Redirecting…' : 'Prepay & get started'}
          </button>
        </div>
        {/* Expedited */}
        <div style={{ ...cardStyle, borderColor: '#8a2433' }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#8a2433' }}>Expedited · Rush</div>
          <div style={{ color: '#5e554b', fontSize: 13.5, margin: '4px 0 10px' }}>
            Jump to the front of the expert queue with a priority turnaround —
            best if a lender or deadline is waiting on these returns.
          </div>
          <div style={{ fontWeight: 700, fontSize: 22 }}>{money(expeditedTotal)}</div>
          <div style={{ color: '#5e554b', fontSize: 12 }}>starting deposit · includes rush fee</div>
          <button onClick={() => go(true)} disabled={loading !== null} style={btnStyle(true, loading === 'expedited')}>
            {loading === 'expedited' ? 'Redirecting…' : 'Prepay expedited'}
          </button>
        </div>
      </div>
      {error && <p style={{ color: '#8a2433', fontSize: 13, marginTop: 10 }}>{error}</p>}
      <p style={{ color: '#5e554b', fontSize: 12, marginTop: 10 }}>
        This is a starting deposit to begin the work, applied against your final
        invoice — not the full price. Your expert reviews your records and
        confirms the complete quote (some situations carry additional fees)
        before anything further is charged.
      </p>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 240,
  background: '#fff',
  border: '1px solid #e4dcd0',
  borderRadius: 10,
  padding: '16px 18px',
};

function btnStyle(primary: boolean, busy: boolean): React.CSSProperties {
  return {
    display: 'block',
    width: '100%',
    marginTop: 12,
    padding: '12px 16px',
    borderRadius: 8,
    border: 'none',
    cursor: busy ? 'default' : 'pointer',
    fontWeight: 600,
    fontSize: 15,
    color: '#fff',
    background: primary ? '#8a2433' : '#211c17',
    opacity: busy ? 0.7 : 1,
  };
}
