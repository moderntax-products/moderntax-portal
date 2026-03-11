'use client';

import { useState, useRef } from 'react';

interface ExpertTranscriptUploadProps {
  assignmentId: string;
  entityId: string;
  onComplete: () => void;
}

export function ExpertTranscriptUpload({
  assignmentId,
  entityId,
  onComplete,
}: ExpertTranscriptUploadProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ uploaded_count: number; sla_met: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(Array.from(e.target.files));
      setError('');
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (files.length === 0) {
      setError('Please select files to upload');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const formData = new FormData();
      formData.append('assignmentId', assignmentId);
      formData.append('entityId', entityId);
      files.forEach((file) => formData.append('files', file));

      const res = await fetch('/api/expert/upload-transcript', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Upload failed');
        return;
      }

      setResult(data);
      setTimeout(() => onComplete(), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setLoading(false);
    }
  };

  if (result) {
    return (
      <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <p className="text-sm font-semibold text-green-800">
            {result.uploaded_count} {result.uploaded_count === 1 ? 'file' : 'files'} uploaded successfully
          </p>
        </div>
        <p className="text-xs text-green-600 mt-1">
          SLA: {result.sla_met ? 'Met' : 'Missed'}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleUpload} className="space-y-3 p-4 bg-blue-50 border border-blue-200 rounded-lg">
      <h4 className="text-sm font-semibold text-blue-800">Upload Transcripts</h4>
      <p className="text-xs text-gray-600">
        Upload PDF or HTML transcript files from the IRS batch download script.
      </p>

      <div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.html,.htm"
          multiple
          onChange={handleFileChange}
          className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-blue-100 file:text-blue-700 hover:file:bg-blue-200"
        />
      </div>

      {files.length > 0 && (
        <div className="text-xs text-gray-600">
          {files.length} {files.length === 1 ? 'file' : 'files'} selected:{' '}
          {files.map((f) => f.name).join(', ')}
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading || files.length === 0}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Uploading...' : 'Upload Transcripts'}
        </button>
        <button
          type="button"
          onClick={onComplete}
          className="px-4 py-2 text-gray-600 text-sm hover:text-gray-800"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
