'use client';

import { useState } from 'react';

interface DownloadAllTranscriptsProps {
  requestId: string;
  loanNumber: string;
  totalFiles: number;
}

export function DownloadAllTranscripts({ requestId, loanNumber, totalFiles }: DownloadAllTranscriptsProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/download-all-transcripts?requestId=${encodeURIComponent(requestId)}`);
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to generate download');
        return;
      }

      // Response is a ZIP file
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${loanNumber.replace(/[^a-zA-Z0-9 ]/g, '').trim()} - Transcripts.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download all error:', err);
      setError('Failed to download transcripts');
    } finally {
      setLoading(false);
    }
  };

  if (totalFiles === 0) return null;

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={loading}
        className="flex items-center gap-2 px-4 py-2 bg-mt-green text-white rounded-lg hover:bg-mt-green/90 transition-colors disabled:opacity-50 text-sm font-medium"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        {loading ? 'Preparing ZIP...' : `Download All (${totalFiles} files)`}
      </button>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}
