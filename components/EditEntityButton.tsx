'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface EditEntityButtonProps {
  entityId: string;
  entityName: string;
  currentSignerEmail: string | null;
  currentAddress: string | null;
  currentCity: string | null;
  currentState: string | null;
  currentZipCode: string | null;
  status: string;
}

export function EditEntityButton({
  entityId,
  entityName,
  currentSignerEmail,
  currentAddress,
  currentCity,
  currentState,
  currentZipCode,
  status,
}: EditEntityButtonProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [signerEmail, setSignerEmail] = useState(currentSignerEmail || '');
  const [address, setAddress] = useState(currentAddress || '');
  const [city, setCity] = useState(currentCity || '');
  const [state, setState] = useState(currentState || '');
  const [zipCode, setZipCode] = useState(currentZipCode || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Only show edit button for pending/submitted entities
  if (!['pending', 'submitted'].includes(status)) return null;

  const handleSave = async () => {
    setSaving(true);
    setError('');

    try {
      const updates: Record<string, string> = {};
      if (signerEmail !== (currentSignerEmail || '')) updates.signer_email = signerEmail;
      if (address !== (currentAddress || '')) updates.address = address;
      if (city !== (currentCity || '')) updates.city = city;
      if (state !== (currentState || '')) updates.state = state;
      if (zipCode !== (currentZipCode || '')) updates.zip_code = zipCode;

      if (Object.keys(updates).length === 0) {
        setIsOpen(false);
        return;
      }

      const res = await fetch('/api/entity/update', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId, updates }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.details || data.error || 'Failed to update');
      }

      setIsOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
        Edit
      </button>
    );
  }

  return (
    <div className="mt-4 bg-blue-50 border border-blue-200 rounded-lg p-4">
      <h4 className="text-sm font-semibold text-blue-800 mb-3">Edit {entityName}</h4>

      {error && (
        <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">{error}</div>
      )}

      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Signer Email</label>
          <input
            type="email"
            value={signerEmail}
            onChange={(e) => setSignerEmail(e.target.value)}
            placeholder="signer@email.com"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-300 focus:border-blue-300"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Address</label>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Street address"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-300 focus:border-blue-300"
          />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">City</label>
            <input
              type="text"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-300 focus:border-blue-300"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">State</label>
            <input
              type="text"
              value={state}
              onChange={(e) => setState(e.target.value)}
              maxLength={2}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-300 focus:border-blue-300"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">ZIP</label>
            <input
              type="text"
              value={zipCode}
              onChange={(e) => setZipCode(e.target.value)}
              maxLength={10}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-300 focus:border-blue-300"
            />
          </div>
        </div>
      </div>

      <div className="flex gap-2 mt-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-mt-green text-white text-sm font-semibold rounded-lg hover:bg-opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
        <button
          onClick={() => setIsOpen(false)}
          disabled={saving}
          className="px-4 py-2 text-gray-600 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
