'use client';

import { useState } from 'react';

interface FreeTrialToggleProps {
  clientId: string;
  clientName: string;
  initialValue: boolean;
}

export function FreeTrialToggle({ clientId, clientName, initialValue }: FreeTrialToggleProps) {
  const [freeTrial, setFreeTrial] = useState(initialValue);
  const [loading, setLoading] = useState(false);

  const handleToggle = async () => {
    const newValue = !freeTrial;
    setLoading(true);
    try {
      const res = await fetch('/api/admin/update-client', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, free_trial: newValue }),
      });
      if (res.ok) {
        setFreeTrial(newValue);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleToggle}
      disabled={loading}
      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
        freeTrial
          ? 'bg-green-100 text-green-800 hover:bg-green-200'
          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
      } disabled:opacity-50`}
      title={`Click to ${freeTrial ? 'end' : 'enable'} free trial for ${clientName}`}
    >
      {loading ? (
        '...'
      ) : freeTrial ? (
        'Active'
      ) : (
        'Completed'
      )}
    </button>
  );
}
