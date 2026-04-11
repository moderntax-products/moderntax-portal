'use client';

import { useState } from 'react';

export function NotifyProcessorsButton() {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [result, setResult] = useState<string>('');

  const handleClick = async () => {
    setStatus('sending');
    try {
      const res = await fetch('/api/admin/notify-processors', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setStatus('sent');
        setResult(`Sent to ${data.sent} processor${data.sent !== 1 ? 's' : ''}`);
      } else {
        setStatus('error');
        setResult(data.error || 'Failed');
      }
    } catch {
      setStatus('error');
      setResult('Network error');
    }
    // Reset after 5 seconds
    setTimeout(() => { setStatus('idle'); setResult(''); }, 5000);
  };

  return (
    <button
      onClick={handleClick}
      disabled={status === 'sending'}
      className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
        status === 'sent'
          ? 'bg-green-600 text-white'
          : status === 'error'
          ? 'bg-red-600 text-white'
          : status === 'sending'
          ? 'bg-gray-400 text-white cursor-not-allowed'
          : 'bg-mt-green text-white hover:bg-mt-green/90'
      }`}
    >
      {status === 'sending' ? 'Sending...' :
       status === 'sent' ? result :
       status === 'error' ? result :
       'Email All Processors'}
    </button>
  );
}
