'use client';

/**
 * BillingSettingsForm — Mercury auto-pay enrollment + payment settings.
 *
 * Two-step UX:
 *   1. Fill in payment method + AP contact + billing address.
 *   2. Click "Save & Enroll in Auto-Pay" — saves settings AND creates
 *      the Mercury customer record. Once enrolled, Mercury sends invoices
 *      automatically and the manager pays via Mercury's hosted pay page
 *      (which saves their bank info for future invoices).
 *
 * Status pill at top shows enrollment state:
 *   - "Setup needed" — missing required fields
 *   - "Saved, not enrolled" — fields filled but Mercury customer not created
 *   - "Enrolled with Mercury" — mercury_customer_id is set
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  initialPaymentMethod: string;
  initialApEmail: string;
  initialApPhone: string;
  initialAddressLine1: string;
  initialAddressLine2: string;
  initialAddressCity: string;
  initialAddressState: string;
  initialAddressPostalCode: string;
  mercuryCustomerId: string | null;
}

export function BillingSettingsForm({
  initialPaymentMethod,
  initialApEmail,
  initialApPhone,
  initialAddressLine1,
  initialAddressLine2,
  initialAddressCity,
  initialAddressState,
  initialAddressPostalCode,
  mercuryCustomerId,
}: Props) {
  const router = useRouter();
  const [paymentMethod, setPaymentMethod] = useState(initialPaymentMethod);
  const [apEmail, setApEmail] = useState(initialApEmail);
  const [apPhone, setApPhone] = useState(initialApPhone);
  const [addressLine1, setAddressLine1] = useState(initialAddressLine1);
  const [addressLine2, setAddressLine2] = useState(initialAddressLine2);
  const [addressCity, setAddressCity] = useState(initialAddressCity);
  const [addressState, setAddressState] = useState(initialAddressState);
  const [addressPostalCode, setAddressPostalCode] = useState(initialAddressPostalCode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [statusMsg, setStatusMsg] = useState('');

  const enrolled = !!mercuryCustomerId;
  const requiredFilled = !!(apEmail && addressLine1 && addressCity && addressState && addressPostalCode);

  const handleSave = async (alsoEnroll: boolean) => {
    setSaving(true);
    setError('');
    setStatusMsg('');

    try {
      const settingsRes = await fetch('/api/billing/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          billing_payment_method: paymentMethod || null,
          billing_ap_email: apEmail || null,
          billing_ap_phone: apPhone || null,
          address_line1: addressLine1 || null,
          address_line2: addressLine2 || null,
          address_city: addressCity || null,
          address_state: addressState || null,
          address_postal_code: addressPostalCode || null,
        }),
      });

      if (!settingsRes.ok) {
        const data = await settingsRes.json();
        throw new Error(data.error || 'Failed to save settings');
      }

      if (alsoEnroll) {
        const enrollRes = await fetch('/api/billing/setup-mercury', { method: 'POST' });
        const enrollData = await enrollRes.json();
        if (!enrollRes.ok) {
          throw new Error(enrollData.detail || enrollData.error || 'Mercury enrollment failed');
        }
        setStatusMsg(enrollData.message || 'Enrolled with Mercury — auto-pay is active.');
      } else {
        setStatusMsg('Settings saved.');
      }

      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Status pill */}
      <div>
        {enrolled ? (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            Enrolled with Mercury — auto-pay active
          </span>
        ) : requiredFilled ? (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
            Saved — click &quot;Enroll in Auto-Pay&quot; to activate Mercury
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-700">
            Add AP email + billing address to enroll
          </span>
        )}
      </div>

      {/* Contact + payment method */}
      <div>
        <h3 className="text-xs font-bold text-gray-700 uppercase tracking-wide mb-3">Accounts Payable Contact</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">AP Email <span className="text-red-500">*</span></label>
            <input type="email" value={apEmail} onChange={(e) => setApEmail(e.target.value)} placeholder="ap@yourcompany.com"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-mt-green" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">AP Phone</label>
            <input type="tel" value={apPhone} onChange={(e) => setApPhone(e.target.value)} placeholder="(555) 123-4567"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-mt-green" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Preferred Method</label>
            <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-mt-green">
              <option value="">Select...</option>
              <option value="ach">ACH</option>
              <option value="wire">Wire Transfer</option>
            </select>
          </div>
        </div>
      </div>

      {/* Billing Address — required for Mercury */}
      <div>
        <h3 className="text-xs font-bold text-gray-700 uppercase tracking-wide mb-3">Billing Address (required for Mercury)</h3>
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Street <span className="text-red-500">*</span></label>
              <input type="text" value={addressLine1} onChange={(e) => setAddressLine1(e.target.value)} placeholder="123 Main St"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-mt-green" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Suite / Apt</label>
              <input type="text" value={addressLine2} onChange={(e) => setAddressLine2(e.target.value)} placeholder="Suite 200"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-mt-green" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">City <span className="text-red-500">*</span></label>
              <input type="text" value={addressCity} onChange={(e) => setAddressCity(e.target.value)} placeholder="Sacramento"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-mt-green" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">State <span className="text-red-500">*</span></label>
              <input type="text" value={addressState} onChange={(e) => setAddressState(e.target.value.toUpperCase())} placeholder="CA" maxLength={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-mt-green uppercase" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">ZIP <span className="text-red-500">*</span></label>
              <input type="text" value={addressPostalCode} onChange={(e) => setAddressPostalCode(e.target.value)} placeholder="95814" maxLength={10}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-mt-green" />
            </div>
          </div>
        </div>
      </div>

      {/* Save + Enroll */}
      <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-gray-100">
        <button type="button" onClick={() => handleSave(false)} disabled={saving}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50 transition-colors">
          {saving ? 'Saving…' : 'Save settings only'}
        </button>
        <button type="button" onClick={() => handleSave(true)} disabled={saving || !requiredFilled}
          className={`px-5 py-2 rounded-lg text-sm font-bold transition-colors ${
            saving || !requiredFilled
              ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
              : 'bg-mt-green text-white hover:bg-mt-green/90'
          }`}>
          {saving ? 'Saving…' : enrolled ? 'Update & re-enroll' : 'Save & Enroll in Auto-Pay'}
        </button>
        {error && <p className="text-xs text-red-600">{error}</p>}
        {statusMsg && <p className="text-xs text-emerald-700 font-medium">{statusMsg}</p>}
      </div>

      <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-xs text-blue-900 leading-relaxed">
        <p className="font-semibold mb-1">How auto-pay works</p>
        <p>Once enrolled, ModernTax sends each monthly invoice through Mercury. The first time you click &quot;Pay&quot; on a Mercury invoice, you authorize ACH debit and Mercury saves your bank info. Subsequent invoices auto-debit on the due date — you only see them in the Invoice History below.</p>
      </div>
    </div>
  );
}
