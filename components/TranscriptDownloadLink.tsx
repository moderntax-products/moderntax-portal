'use client';

import { useState } from 'react';

interface TranscriptDownloadLinkProps {
  storagePath: string;
  label: string;
}

export function TranscriptDownloadLink({ storagePath, label }: TranscriptDownloadLinkProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/download-transcript?path=${encodeURIComponent(storagePath)}`);
      const data = await res.json();
      if (res.ok && data.url) {
        window.open(data.url, '_blank');
      } else {
        setError(data.error || 'Failed to download transcript');
      }
    } catch (err) {
      console.error('Download error:', err);
      setError('Failed to download transcript');
    } finally {
      setLoading(false);
    }
  };

  // Extract filename from storage path for display
  const fileName = storagePath.split('/').pop() || label;

  return (
    <>
    <button
      onClick={handleClick}
      disabled={loading}
      className="flex items-center gap-3 w-full p-3 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors disabled:opacity-50 text-left"
    >
      <svg className="w-5 h-5 text-blue-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      <div className="min-w-0">
        <p className="text-sm font-medium text-blue-600 truncate">
          {loading ? 'Generating link...' : label}
        </p>
        <p className="text-xs text-gray-500 truncate">{decodeURIComponent(fileName)}</p>
      </div>
    </button>
    {error && (
      <p className="text-xs text-red-600 mt-1">{error}</p>
    )}
    </>
  );
}
