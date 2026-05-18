'use client';

import { useState, useRef } from 'react';

interface Admin8821UploadProps {
  entityId: string;
  entityName: string;
  currentUrl: string | null;
  /** Existing signer_email on the entity, pre-populates the borrower-email field. */
  signerEmail?: string | null;
  /** Storage path of the post-acceptance expert-regenerated PDF (separate from borrower-signed). */
  expertRegeneratedUrl?: string | null;
  onUploaded?: () => void;
}

export function Admin8821Upload({
  entityId,
  // entityName is available via props for future use
  currentUrl,
  signerEmail,
  expertRegeneratedUrl,
  onUploaded,
}: Admin8821UploadProps) {
  const [uploading, setUploading] = useState(false);
  const [opening, setOpening] = useState<'signed' | 'expert_regenerated' | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Borrower email — manual fallback for the PDF extractor. Pre-populated from
  // the entity's signer_email if already known. Same field/precedence rules as
  // the Processor8821Panel — manual entry beats PDF extraction.
  const [borrowerEmail, setBorrowerEmail] = useState<string>(signerEmail || '');
  const [needsManualEmail, setNeedsManualEmail] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const trimmedEmail = borrowerEmail.trim();
  const borrowerEmailValid = !trimmedEmail || /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(trimmedEmail);

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
    if (!borrowerEmailValid) {
      setMessage({ type: 'error', text: 'Borrower email is not a valid email address.' });
      return;
    }

    setUploading(true);
    setMessage(null);
    setNeedsManualEmail(false);

    try {
      const formData = new FormData();
      formData.append('entityId', entityId);
      formData.append('file', file);
      if (trimmedEmail) {
        formData.append('borrowerEmail', trimmedEmail);
      }

      const res = await fetch('/api/admin/upload-8821', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error || 'Upload failed' });
        return;
      }

      // Surface "needs manual entry" when no email was found anywhere — keep
      // the panel open so the admin can paste the borrower email and resave.
      if (data.emailExtraction?.needsManualEntry) {
        setNeedsManualEmail(true);
        setMessage({
          type: 'success',
          text: 'Signed 8821 uploaded. We could not detect a borrower email — please add it below.',
        });
        if (fileRef.current) fileRef.current.value = '';
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

  // SOC 2 CC7.2 — audit log fires server-side on every signed-URL request.
  // Open the URL in a new tab so the admin's current page state isn't lost.
  const handleView = async (kind: 'signed' | 'expert_regenerated') => {
    setOpening(kind);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/download-8821?entityId=${encodeURIComponent(entityId)}&kind=${kind}`);
      const data = await res.json();
      if (!res.ok || !data.url) {
        setMessage({ type: 'error', text: data.error || 'Could not open PDF' });
        return;
      }
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium text-gray-600">Signed 8821:</span>
        {currentUrl ? (
          <>
            <span className="text-xs text-green-600 font-medium">✓ Uploaded</span>
            <button
              onClick={() => handleView('signed')}
              disabled={opening !== null}
              className="text-xs font-medium text-blue-700 hover:text-blue-900 underline disabled:opacity-50"
              title="Open the borrower-signed PDF in a new tab (1-hour signed URL, audit-logged)"
            >
              {opening === 'signed' ? 'Opening…' : 'View PDF'}
            </button>
          </>
        ) : (
          <span className="text-xs text-amber-600 font-medium">Not uploaded</span>
        )}
      </div>

      {expertRegeneratedUrl && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-gray-600">Expert-regenerated 8821:</span>
          <span className="text-xs text-emerald-700 font-medium">✓ Generated</span>
          <button
            onClick={() => handleView('expert_regenerated')}
            disabled={opening !== null}
            className="text-xs font-medium text-blue-700 hover:text-blue-900 underline disabled:opacity-50"
            title="Open the post-acceptance PDF with assigned-expert credentials (UNSIGNED — borrower signature on the original)"
          >
            {opening === 'expert_regenerated' ? 'Opening…' : 'View regen’d PDF'}
          </button>
          <span className="text-[10px] text-gray-500 italic">unsigned · use alongside the original</span>
        </div>
      )}

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

      {/* Borrower email — optional manual override. Same precedence as Processor8821Panel. */}
      <div>
        <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">
          Borrower email <span className="text-gray-400 normal-case">(optional)</span>
        </label>
        <input
          type="email"
          value={borrowerEmail}
          onChange={(e) => { setBorrowerEmail(e.target.value); setNeedsManualEmail(false); }}
          placeholder="e.g. owner@gmail.com"
          className={`w-full px-2 py-1 text-xs border rounded bg-white focus:outline-none focus:ring-1 ${
            !borrowerEmailValid
              ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
              : needsManualEmail
                ? 'border-amber-400 focus:border-amber-500 focus:ring-amber-500'
                : 'border-gray-300 focus:border-indigo-500 focus:ring-indigo-500'
          }`}
        />
        {!borrowerEmailValid && (
          <p className="mt-0.5 text-[10px] text-red-700">Invalid email format.</p>
        )}
        {needsManualEmail && borrowerEmailValid && (
          <p className="mt-0.5 text-[10px] text-amber-700">
            No borrower email found in the PDF — paste it from the DocuSign envelope to enable compliance follow-ups.
          </p>
        )}
      </div>

      {message && (
        <p className={`text-xs ${message.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
