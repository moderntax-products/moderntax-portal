'use client';

import { useState, useRef } from 'react';

interface Admin8821UploadProps {
  entityId: string;
  entityName: string;
  /**
   * The canonical processor-visible 8821 (signed_8821_url). Once set,
   * admin uploads route to adminUploadedUrl below instead of replacing
   * this — preserves the processor's pre-signed PDF as source of truth
   * on processor / manager-facing surfaces.
   */
  currentUrl: string | null;
  /** Existing signer_email on the entity, pre-populates the borrower-email field. */
  signerEmail?: string | null;
  /** Storage path of the post-acceptance expert-regenerated PDF (separate from borrower-signed). */
  expertRegeneratedUrl?: string | null;
  /**
   * Admin-uploaded 8821 (admin_uploaded_8821_url). Set when an admin
   * uploaded a replacement after the processor (or any other intake
   * source) already supplied signed_8821_url. Surfaces on admin/expert
   * UIs only.
   */
  adminUploadedUrl?: string | null;
  onUploaded?: () => void;
}

export function Admin8821Upload({
  entityId,
  // entityName is available via props for future use
  currentUrl,
  signerEmail,
  expertRegeneratedUrl,
  adminUploadedUrl,
  onUploaded,
}: Admin8821UploadProps) {
  const [uploading, setUploading] = useState(false);
  const [opening, setOpening] = useState<'signed' | 'expert_regenerated' | 'admin_uploaded' | null>(null);
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
  const handleView = async (kind: 'signed' | 'expert_regenerated' | 'admin_uploaded') => {
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
        <span className="text-xs font-medium text-gray-600">Signed 8821 (processor):</span>
        {currentUrl ? (
          <>
            <span className="text-xs text-green-600 font-medium">✓ Uploaded</span>
            <button
              onClick={() => handleView('signed')}
              disabled={opening !== null}
              className="text-xs font-medium text-blue-700 hover:text-blue-900 underline disabled:opacity-50"
              title="Open the processor-uploaded PDF in a new tab (1-hour signed URL, audit-logged). This is the canonical PDF the processor/manager sees — admin uploads land in the slot below instead of overwriting it."
            >
              {opening === 'signed' ? 'Opening…' : 'View PDF'}
            </button>
            <span className="text-[10px] text-gray-500 italic" title="The processor-supplied 8821 is the source of truth on processor/manager-facing surfaces and cannot be replaced from admin. Use the Admin upload slot below for an admin-only replacement.">🔒 locked</span>
          </>
        ) : (
          <span className="text-xs text-amber-600 font-medium">Not uploaded</span>
        )}
      </div>

      {/* Admin-only override slot. Driver: 2026-05-28 Matt — "system should
          never overwrite or replace uploaded 8821 from the processor with
          other additions from admin." This row only renders something
          useful when the admin has explicitly uploaded an override. */}
      {adminUploadedUrl && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-gray-600">Admin upload:</span>
          <span className="text-xs text-emerald-700 font-medium">✓ Uploaded</span>
          <button
            onClick={() => handleView('admin_uploaded')}
            disabled={opening !== null}
            className="text-xs font-medium text-blue-700 hover:text-blue-900 underline disabled:opacity-50"
            title="Open the admin-supplied override PDF (visible only to admin + assigned expert). Processor / manager surfaces continue to show the original above."
          >
            {opening === 'admin_uploaded' ? 'Opening…' : 'View admin PDF'}
          </button>
          <span className="text-[10px] text-gray-500 italic">admin/expert only</span>
        </div>
      )}

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
          title={currentUrl
            ? 'Uploads to the admin-only override slot. The processor\'s original above stays untouched.'
            : 'Uploads as the canonical signed 8821 for this entity (no processor upload on file yet).'}
        >
          {uploading
            ? 'Uploading...'
            : currentUrl
              ? (adminUploadedUrl ? 'Replace Admin Upload' : 'Upload Admin Override')
              : 'Upload 8821'}
        </button>
      </div>
      {currentUrl && (
        <p className="text-[10px] text-gray-500 leading-snug">
          The processor&apos;s original 8821 is locked. Anything uploaded here goes to a
          separate admin/expert-only slot — processor and manager views will continue to
          show the original above.
        </p>
      )}

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
