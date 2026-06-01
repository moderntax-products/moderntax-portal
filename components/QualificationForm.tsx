'use client';

/**
 * QualificationForm — shown on signup between email verify and password step.
 * Calls /api/auth/qualify to score answers before any auth user is created.
 */

import { useState } from 'react';

export type QualDecision = 'auto_qualified' | 'manual_review' | 'disqualified' | null;

interface QualificationFormProps {
  onComplete: (decision: QualDecision, answers: Record<string, string>) => void;
}

const SEGMENTS = [
  { value: 'sba_lender_bank',     label: 'SBA Lender (Bank or Credit Union)' },
  { value: 'sba_lender_cdc',      label: 'SBA Lender (CDC / Non-Profit)' },
  { value: 'commercial_bank',     label: 'Commercial Bank (non-SBA)' },
  { value: 'fintech_originator',  label: 'Fintech / LOS Platform' },
  { value: 'accountant_cpa',      label: 'Accounting Firm / CPA' },
  { value: 'insurance',           label: 'Insurance Underwriting' },
  { value: 'employment_verif',    label: 'Employment / Income Verification' },
  { value: 'individual_borrower', label: 'I am a borrower (not a lender)' },
  { value: 'other',               label: 'Other' },
];

const VOLUMES = [
  { value: '0',        label: 'Just exploring / not sure yet' },
  { value: '1_5',      label: '1–5 per month' },
  { value: '6_25',     label: '6–25 per month' },
  { value: '26_100',   label: '26–100 per month' },
  { value: '101_plus', label: '100+ per month' },
];

const VENDORS = [
  { value: 'tax_guard',     label: 'Tax Guard' },
  { value: 'compliance_ir', label: '4506-C / paper process (internal)' },
  { value: 'ives_provider', label: 'Another IVES provider' },
  { value: 'none',          label: 'No current process (new to this)' },
  { value: 'other',         label: 'Other' },
];

export function QualificationForm({ onComplete }: QualificationFormProps) {
  const [segment, setSegment] = useState('');
  const [volume, setVolume] = useState('');
  const [vendor, setVendor] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejection, setRejection] = useState<{ message: string } | null>(null);

  if (rejection) {
    return (
      <div className="text-center py-8 px-4 max-w-md mx-auto">
        <div className="w-14 h-14 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-7 h-7 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-gray-900 mb-2">Not the right fit today</h2>
        <p className="text-gray-600 text-sm leading-relaxed mb-6">{rejection.message}</p>
        <p className="text-gray-400 text-xs">
          Have a specific lending use case we missed?{' '}
          <a href="mailto:matt@moderntax.io" className="text-mt-green hover:underline">Email us directly.</a>
        </p>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!segment || !volume) { setError('Please answer both required questions.'); return; }
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/auth/qualify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qual_segment: segment, qual_monthly_volume: volume, qual_current_vendor: vendor || null }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Something went wrong.'); return; }
      if (data.score === 'disqualified') {
        setRejection({ message: data.user_message || 'ModernTax is built for SBA lenders and financial institutions.' });
        return;
      }
      onComplete(data.score, { qual_segment: segment, qual_monthly_volume: volume, qual_current_vendor: vendor });
    } catch (err: any) {
      setError(err?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="text-center mb-2">
        <h2 className="text-xl font-bold text-mt-dark">Tell us about your team</h2>
        <p className="text-gray-500 text-sm mt-1">We tailor the setup to your lending workflow.</p>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-1.5">
          What type of institution are you? <span className="text-red-500">*</span>
        </label>
        <select value={segment} onChange={e => setSegment(e.target.value)} required
          className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-transparent outline-none bg-white">
          <option value="">Select your institution type...</option>
          {SEGMENTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-1.5">
          How many IRS transcript verifications do you need per month? <span className="text-red-500">*</span>
        </label>
        <select value={volume} onChange={e => setVolume(e.target.value)} required
          className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-transparent outline-none bg-white">
          <option value="">Select approximate volume...</option>
          {VOLUMES.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-1.5">
          What do you use today for transcript verification? <span className="text-gray-400 font-normal">(optional)</span>
        </label>
        <select value={vendor} onChange={e => setVendor(e.target.value)}
          className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-transparent outline-none bg-white">
          <option value="">Select current process...</option>
          {VENDORS.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
        </select>
      </div>

      <button type="submit" disabled={loading}
        className="w-full bg-mt-green text-white py-3 rounded-lg font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-60">
        {loading ? 'Checking...' : 'Continue →'}
      </button>
    </form>
  );
}
