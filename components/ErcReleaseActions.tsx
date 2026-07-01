'use client';

import { useState } from 'react';

/**
 * "I made the call" confirmation for the ERC self-service release page.
 * Logs (no login) that the taxpayer called the IRS to correct the address of
 * record + request reissuance, so ModernTax can track and follow up.
 */
export function ErcReleaseActions({ token }: { token: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setError(null);
    setState('sending');
    try {
      const res = await fetch(`/api/public/erc-call-confirm/${token}`, { method: 'POST' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || 'Could not record that. Please try again.');
        setState('idle');
        return;
      }
      setState('done');
    } catch {
      setError('Network error — please try again.');
      setState('idle');
    }
  };

  if (state === 'done') {
    return (
      <p style={{ margin: 0, fontSize: 14.5, fontWeight: 600, color: '#2f6e4f' }}>
        ✓ Thanks — we’ve noted that you called. We’ll watch your account and follow up once the address updates.
      </p>
    );
  }

  return (
    <div>
      <button onClick={confirm} disabled={state === 'sending'}
        style={{ padding: '11px 18px', borderRadius: 9, border: '1px solid #8a2433', background: '#fff', color: '#8a2433',
          fontWeight: 600, fontSize: 15, cursor: state === 'sending' ? 'default' : 'pointer', opacity: state === 'sending' ? 0.7 : 1 }}>
        {state === 'sending' ? 'Saving…' : 'I made the call ✓'}
      </button>
      {error && <p style={{ color: '#8a2433', fontSize: 13, marginTop: 8 }}>{error}</p>}
    </div>
  );
}
