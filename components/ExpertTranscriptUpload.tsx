'use client';

import { useState, useRef } from 'react';

interface ExpertTranscriptUploadProps {
  assignmentId: string;
  entityId: string;
  entityYears: string[];
  existingUrls: string[];
  onComplete: () => void;
}

export function ExpertTranscriptUpload({
  assignmentId,
  entityId,
  entityYears,
  existingUrls,
  onComplete,
}: ExpertTranscriptUploadProps) {
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<string[]>(existingUrls || []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Expected files: 2 per year (Record of Account + Tax Return)
  const expectedCount = entityYears.length * 2;
  const currentCount = uploadedFiles.length;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      // Append new files to pending list instead of replacing
      setPendingFiles((prev) => [...prev, ...Array.from(e.target.files!)]);
      setError('');
      // Reset file input so same file can be selected again
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pendingFiles.length === 0) {
      setError('Please select files to upload');
      return;
    }

    setLoading(true);
    setError('');
    setProgress({ current: 0, total: pendingFiles.length });

    try {
      const newUrls: string[] = [];
      for (let i = 0; i < pendingFiles.length; i++) {
        const formData = new FormData();
        formData.append('assignmentId', assignmentId);
        formData.append('entityId', entityId);
        formData.append('files', pendingFiles[i]);

        const res = await fetch('/api/expert/upload-transcript', {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          let errorMsg = `Upload failed for ${pendingFiles[i].name}`;
          try {
            const data = await res.json();
            errorMsg = data.error || errorMsg;
          } catch {
            if (res.status === 413) {
              errorMsg = `${pendingFiles[i].name} is too large (max ~4MB per file). Try compressing or splitting the file.`;
            } else {
              const text = await res.text().catch(() => '');
              errorMsg = `Upload failed (${res.status}): ${text.slice(0, 100) || 'Unknown error'}`;
            }
          }
          setError(errorMsg);
          return;
        }

        const data = await res.json();
        newUrls.push(...(data.transcript_urls || []));
        setProgress({ current: i + 1, total: pendingFiles.length });
      }

      // Update local state with newly uploaded files
      setUploadedFiles((prev) => [...prev, ...newUrls]);
      setPendingFiles([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setLoading(false);
    }
  };

  const handleMarkComplete = async () => {
    setLoading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('assignmentId', assignmentId);
      formData.append('entityId', entityId);
      formData.append('complete', 'true');

      const res = await fetch('/api/expert/upload-transcript', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to mark complete');
        return;
      }

      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark complete');
    } finally {
      setLoading(false);
    }
  };

  const getFileName = (url: string) => {
    const parts = url.split('/');
    const filename = parts[parts.length - 1];
    // Remove timestamp prefix
    return filename.replace(/^\d+-/, '');
  };

  return (
    <div className="space-y-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-blue-800">Upload Transcripts</h4>
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
          currentCount >= expectedCount
            ? 'bg-green-100 text-green-700'
            : currentCount > 0
            ? 'bg-amber-100 text-amber-700'
            : 'bg-gray-100 text-gray-500'
        }`}>
          {currentCount} / {expectedCount} files
        </span>
      </div>

      {/* Expected files guide */}
      <div className="text-xs text-gray-600 bg-white/60 p-3 rounded border border-blue-100">
        <p className="font-medium text-gray-700 mb-1">Expected files for {entityYears.join(', ')}:</p>
        <div className="grid grid-cols-2 gap-1">
          {entityYears.map((year) => (
            <div key={year} className="flex flex-col gap-0.5">
              <span className="text-gray-500">
                {currentCount > 0 ? '  ' : '  '} Tax Return Transcript — {year}
              </span>
              <span className="text-gray-500">
                {currentCount > 0 ? '  ' : '  '} Record of Account — {year}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Already uploaded files */}
      {uploadedFiles.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-green-700">Uploaded ({uploadedFiles.length}):</p>
          <div className="space-y-1">
            {uploadedFiles.map((url, i) => (
              <div key={i} className="flex items-center gap-2 text-xs bg-green-50 px-2 py-1.5 rounded">
                <svg className="w-3.5 h-3.5 text-green-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-green-800 truncate">{getFileName(url)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* File input — always available to add more */}
      <div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.html,.htm"
          multiple
          onChange={handleFileChange}
          className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-blue-100 file:text-blue-700 hover:file:bg-blue-200"
        />
        <p className="text-[10px] text-gray-500 mt-1">
          Select additional files to add. Previously uploaded files are preserved.
        </p>
      </div>

      {/* Pending files (not yet uploaded) */}
      {pendingFiles.length > 0 && !loading && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-blue-700">Ready to upload ({pendingFiles.length}):</p>
          {pendingFiles.map((f, i) => (
            <div key={i} className="flex items-center justify-between text-xs bg-blue-100/50 px-2 py-1.5 rounded">
              <span className="text-blue-800 truncate">{f.name}</span>
              <button
                type="button"
                onClick={() => removePendingFile(i)}
                className="text-red-500 hover:text-red-700 ml-2 flex-shrink-0"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Upload Progress */}
      {loading && progress.total > 0 && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs">
            <span className="text-blue-700 font-medium">
              Uploading file {progress.current + 1} of {progress.total}...
            </span>
            <span className="text-blue-600">
              {Math.round((progress.current / progress.total) * 100)}%
            </span>
          </div>
          <div className="w-full bg-blue-200 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all duration-300"
              style={{ width: `${(progress.current / progress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}

      {/* Action buttons */}
      <div className="flex gap-2 flex-wrap">
        {pendingFiles.length > 0 && (
          <button
            type="button"
            onClick={handleUpload}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? `Uploading ${progress.current + 1}/${progress.total}...` : `Upload ${pendingFiles.length} File${pendingFiles.length > 1 ? 's' : ''}`}
          </button>
        )}

        {uploadedFiles.length >= expectedCount && (
          <button
            type="button"
            onClick={handleMarkComplete}
            disabled={loading}
            className="px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 disabled:opacity-50"
          >
            {loading ? 'Completing...' : 'Mark Complete & Submit'}
          </button>
        )}

        {uploadedFiles.length > 0 && uploadedFiles.length < expectedCount && (
          <button
            type="button"
            onClick={handleMarkComplete}
            disabled={loading}
            className="px-4 py-2 bg-amber-500 text-white text-sm rounded-lg hover:bg-amber-600 disabled:opacity-50"
          >
            {loading ? 'Completing...' : `Submit Anyway (${expectedCount - currentCount} files short)`}
          </button>
        )}

        <button
          type="button"
          onClick={onComplete}
          disabled={loading}
          className="px-4 py-2 text-gray-600 text-sm hover:text-gray-800 disabled:opacity-50"
        >
          {uploadedFiles.length > 0 && uploadedFiles.length < expectedCount ? 'Save & Continue Later' : 'Close'}
        </button>
      </div>

      {/* Multi-session hint */}
      {uploadedFiles.length > 0 && uploadedFiles.length < expectedCount && (
        <p className="text-[10px] text-gray-500 italic">
          Your progress is saved automatically. You can close this panel and return in a new session to upload remaining files.
        </p>
      )}
    </div>
  );
}
