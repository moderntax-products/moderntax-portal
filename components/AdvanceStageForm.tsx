'use client';

/**
 * Admin form to advance an ERC recovery engagement to the next stage.
 * Posts to /api/admin/erc-engagement/[token]/advance and refreshes.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  token: string;
  nextStage: { key: string; label: string };
  defaultEmail: string;
  hasMailingAddress: boolean;
}

export function AdvanceStageForm({ token, nextStage, defaultEmail, hasMailingAddress }: Props) {
  const router = useRouter();
  const [merchantNote, setMerchantNote] = useState('');
  const [internalNote, setInternalNote] = useState('');
  const [merchantEmail, setMerchantEmail] = useState(defaultEmail);
  const [merchantName, setMerchantName] = useState('');
  const [suppressEmail, setSuppressEmail] = useState(false);
  // Mailing-address capture (shown when not yet on file)
  const [address1, setAddress1] = useState('');
  const [address2, setAddress2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const body: any = {
        to_stage: nextStage.key,
        merchant_note: merchantNote || undefined,
        internal_note: internalNote || undefined,
        merchant_email: merchantEmail || undefined,
        merchant_name: merchantName || undefined,
        suppress_email: suppressEmail,
      };
      if (!hasMailingAddress && address1.trim() && city.trim()) {
        body.new_mailing_address = { address1, address2: address2 || undefined, city, state, zip };
      }
      const res = await fetch(`/api/admin/erc-engagement/${token}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed');
        return;
      }
      setSuccess(`Advanced to "${nextStage.label}". Email fired: ${data.email_fired ? 'yes' : 'no'}.`);
      setMerchantNote('');
      setInternalNote('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm">
        Advancing to: <strong className="text-blue-900">{nextStage.label}</strong> (<code className="text-xs">{nextStage.key}</code>)
      </div>

      {!hasMailingAddress && (
        <details className="border border-gray-200 rounded p-3">
          <summary className="text-sm font-medium text-gray-700 cursor-pointer">Capture mailing address (optional)</summary>
          <div className="mt-3 space-y-2">
            <input value={address1} onChange={e => setAddress1(e.target.value)} placeholder="Address line 1" className="w-full border rounded px-2 py-1 text-sm" />
            <input value={address2} onChange={e => setAddress2(e.target.value)} placeholder="Address line 2 (optional)" className="w-full border rounded px-2 py-1 text-sm" />
            <div className="grid grid-cols-3 gap-2">
              <input value={city} onChange={e => setCity(e.target.value)} placeholder="City" className="border rounded px-2 py-1 text-sm" />
              <input value={state} onChange={e => setState(e.target.value)} placeholder="State" maxLength={2} className="border rounded px-2 py-1 text-sm" />
              <input value={zip} onChange={e => setZip(e.target.value)} placeholder="ZIP" maxLength={10} className="border rounded px-2 py-1 text-sm" />
            </div>
          </div>
        </details>
      )}

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">
          Note to merchant <span className="text-gray-400">(shown on tracking page + included in email)</span>
        </label>
        <textarea value={merchantNote} onChange={e => setMerchantNote(e.target.value)} rows={2} maxLength={500} className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Optional — falls back to canned per-stage copy" />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">
          Internal note <span className="text-gray-400">(audit trail only, never shown to merchant)</span>
        </label>
        <textarea value={internalNote} onChange={e => setInternalNote(e.target.value)} rows={2} maxLength={500} className="w-full border rounded px-2 py-1.5 text-sm" placeholder="e.g., IRS confirmation #IRS-2026-0517-3344" />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <input value={merchantEmail} onChange={e => setMerchantEmail(e.target.value)} placeholder="Merchant email" className="border rounded px-2 py-1 text-sm" />
        <input value={merchantName} onChange={e => setMerchantName(e.target.value)} placeholder="Merchant name (for salutation)" className="border rounded px-2 py-1 text-sm" />
      </div>

      <label className="flex items-center gap-2 text-xs text-gray-700">
        <input type="checkbox" checked={suppressEmail} onChange={e => setSuppressEmail(e.target.checked)} />
        Suppress notification email (silent stage update)
      </label>

      {error && <div className="bg-red-50 border border-red-200 text-red-800 text-sm p-2 rounded">{error}</div>}
      {success && <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm p-2 rounded">{success}</div>}

      <button
        type="submit"
        disabled={submitting}
        className="w-full px-4 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded disabled:opacity-50"
      >
        {submitting ? 'Advancing…' : `Advance to "${nextStage.label}"`}
      </button>
    </form>
  );
}
