'use client';

import { useState } from 'react';

interface BillingSettingsFormProps {
  initialPaymentMethod: string;
  initialApEmail: string;
  initialApPhone: string;
}

export function BillingSettingsForm({
  initialPaymentMethod,
  initialApEmail,
  initialApPhone,
}: BillingSettingsFormProps) {
  const [paymentMethod, setPaymentMethod] = useState(initialPaymentMethod);
  const [apEmail, setApEmail] = useState(initialApEmail);
  const [apPhone, setApPhone] = useState(initialApPhone);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);

    try {
      const res = await fetch('/api/billing/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          billing_payment_method: paymentMethod || null,
          billing_ap_email: apEmail || null,
          billing_ap_phone: apPhone || null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }

      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const hasChanges =
    paymentMethod !== initialPaymentMethod ||
    apEmail !== initialApEmail ||
    apPhone !== initialApPhone;

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Payment Method
        </label>
        <select
          value={paymentMethod}
          onChange={(e) => setPaymentMethod(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-mt-green"
        >
          <option value="">Select...</option>
          <option value="ach">ACH</option>
          <option value="wire">Wire Transfer</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          AP Email
        </label>
        <input
          type="email"
          value={apEmail}
          onChange={(e) => setApEmail(e.target.value)}
          placeholder="ap@company.com"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-mt-green"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          AP Phone
        </label>
        <input
          type="tel"
          value={apPhone}
          onChange={(e) => setApPhone(e.target.value)}
          placeholder="(555) 123-4567"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-mt-green"
        />
      </div>

      <div className="flex items-end">
        <button
          onClick={handleSave}
          disabled={saving || !hasChanges}
          className={`px-6 py-2 rounded-lg text-sm font-semibold transition-colors ${
            hasChanges
              ? 'bg-mt-green text-white hover:bg-mt-green/90'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed'
          }`}
        >
          {saving ? 'Saving...' : saved ? 'Saved!' : 'Save'}
        </button>
        {error && <p className="text-xs text-red-600 ml-3">{error}</p>}
        {saved && <p className="text-xs text-green-600 ml-3">Settings updated</p>}
      </div>
    </div>
  );
}
