'use client';

import { useState, useRef } from 'react';

interface Admin8821UploadProps {
  entityId: string;
  entityName: string;
  currentUrl: string | null;
  onUploaded?: () => void;
}

export function Admin8821Upload({
  entityId,
  // entityName is available via props for future use
  currentUrl,
  onUploaded,
}: Admin8821UploadProps) {
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setMessage({ type: 'error', text: 'Please select a PDF file' });
      return;
    }

    if (!file.name.endsWith('.pdf')) {
      setMessage({ type: 'error', text: 'Only PDF files are accepted' });
      return;
    }

    setUploading(true);
    setMessage(null);

    try {
      const formData = new FormData();
      formData.append('entityId', entityId);
      formData.append('file', file);

      const res = await fetch('/api/admin/upload-8821', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error || 'Upload failed' });
        return;
      }

      setMessage({ type: 'success', text: 'Signed 8821 uploaded successfully' });
      if (fileRef.current) fileRef.current.value = '';
      if (onUploaded) onUploaded();
      else window.location.reload();
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Upload failed' });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-600">Signed 8821:</span>
        {currentUrl ? (
          <span className="text-xs text-green-600 font-medium">✓ Uploaded</span>
        ) : (
          <span className="text-xs text-amber-600 font-medium">Not uploaded</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".pdf"
          className="text-xs text-gray-600 file:mr-2 file:py-1 file:px-3 file:rounded file:border file:border-gray-300 file:text-xs file:font-medium file:bg-white file:text-gray-700 hover:file:bg-gray-50"
        />
        <button
          onClick={handleUpload}
          disabled={uploading}
          className="px-3 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50 whitespace-nowrap"
        >
          {uploading ? 'Uploading...' : currentUrl ? 'Replace 8821' : 'Upload 8821'}
        </button>
      </div>

      {message && (
        <p className={`text-xs ${message.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
