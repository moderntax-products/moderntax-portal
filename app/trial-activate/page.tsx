'use client';

/**
 * /trial-activate — Card capture for approved trial users.
 * Users cannot access the dashboard until they complete this page.
 */

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function TrialActivatePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (sessionId) {
      setSuccess(true);
      const t = setTimeout(() => router.push('/'), 2500);
      return () => clearTimeout(t);
    }
  }, [sessionId, router]);

  const handleAddCard = async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/billing/checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          return_url: `${window.location.origin}/trial-activate`,
          cancel_url: `${window.location.origin}/trial-activate`,
          mode: 'setup',
          source: 'trial_activate',
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to start card setup.'); return; }
      if (data.url) { window.location.href = data.url; return; }
      setError('No Stripe URL returned.');
    } catch (err: any) {
      setError(err?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl shadow-lg p-10 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-5">
            <svg className="w-8 h-8 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-mt-dark mb-2">Card saved — you&apos;re all set</h1>
          <p className="text-gray-600 text-sm">Your 1 free transcript pull is ready. Redirecting to your dashboard&hellip;</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-lg p-10 max-w-md w-full">
        <div className="flex items-center gap-2 mb-8">
          <div className="w-8 h-8 bg-mt-green rounded-lg flex items-center justify-center">
            <span className="text-white font-bold text-xs">MT</span>
          </div>
          <span className="font-bold text-mt-dark">ModernTax</span>
        </div>

        <h1 className="text-2xl font-bold text-mt-dark mb-2">Activate your free pull</h1>
        <p className="text-gray-600 text-sm mb-8 leading-relaxed">
          Add a card to unlock your 1 free transcript pull. You won&apos;t be charged until the report is complete.
          After your trial, additional entities are <strong>$59.98 each</strong>, charged only when reports deliver.
        </p>

        <div className="bg-gray-50 rounded-lg p-4 mb-6 space-y-2 text-sm">
          {[
            '1 free transcript pull — no charge today',
            '$59.98/entity after trial — charged only on delivery',
            'Trial valid for 7 days from today',
            'Cancel anytime before your first paid pull',
          ].map((item, i) => (
            <div key={i} className="flex items-start gap-2">
              <svg className="w-4 h-4 text-mt-green mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-gray-700">{item}</span>
            </div>
          ))}
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
        )}

        <button onClick={handleAddCard} disabled={loading}
          className="w-full bg-mt-green text-white py-3.5 rounded-lg font-semibold text-base hover:bg-opacity-90 transition-colors disabled:opacity-60">
          {loading ? 'Opening Stripe...' : 'Add card to start free pull →'}
        </button>
        <p className="text-center text-xs text-gray-400 mt-4">
          Secured by Stripe. ModernTax never stores your card details.
        </p>
      </div>
    </div>
  );
}
