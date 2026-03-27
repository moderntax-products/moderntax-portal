'use client';

import { useState } from 'react';

interface ResendInviteButtonProps {
  userId: string;
  userName: string;
}

export function ResendInviteButton({ userId, userName }: ResendInviteButtonProps) {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  const handleResend = async () => {
    if (status === 'sending' || status === 'sent') return;

    setStatus('sending');
    try {
      const res = await fetch('/api/admin/resend-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to resend invite');
      }

      setStatus('sent');
      // Reset after 5 seconds so they can resend again if needed
      setTimeout(() => setStatus('idle'), 5000);
    } catch (err) {
      console.error('Resend invite error:', err);
      setStatus('error');
      setTimeout(() => setStatus('idle'), 3000);
    }
  };

  if (status === 'sent') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-600 font-medium">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        Sent
      </span>
    );
  }

  if (status === 'error') {
    return (
      <span className="text-xs text-red-600 font-medium">Failed</span>
    );
  }

  return (
    <button
      onClick={handleResend}
      disabled={status === 'sending'}
      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-md transition-colors disabled:opacity-50"
      title={`Resend invite to ${userName}`}
    >
      {status === 'sending' ? (
        <>
          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Sending...
        </>
      ) : (
        <>
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          Resend Invite
        </>
      )}
    </button>
  );
}
