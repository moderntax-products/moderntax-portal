'use client';

import { useState, useRef } from 'react';

interface Entity {
  id: string;
  entity_name: string;
  form_type: string;
  status: string;
  signed_8821_url: string | null;
  signer_email: string | null;
}

interface Processor8821PanelProps {
  entity: Entity;
  requestId: string;
}

const TEMPLATE_INDIVIDUAL = '/templates/8821-individual.pdf';
const TEMPLATE_BUSINESS = '/templates/8821-business.pdf';

export function Processor8821Panel({ entity, requestId: _requestId }: Processor8821PanelProps) {
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const isIndividual = entity.form_type === '1040';
  const templateLabel = isIndividual ? 'Individual (1040)' : 'Business (1065/1120/1120S)';

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setMessage({ type: 'error', text: 'Please select a PDF file' });
      return;
    }

    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setMessage({ type: 'error', text: 'Only PDF files are accepted' });
      return;
    }

    setUploading(true);
    setMessage(null);

    try {
      const formData = new FormData();
      formData.append('entityId', entity.id);
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

      setMessage({ type: 'success', text: 'Signed 8821 uploaded! Entity status updated to 8821 Signed.' });
      if (fileRef.current) fileRef.current.value = '';
      // Refresh page after short delay to show updated status
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Upload failed' });
    } finally {
      setUploading(false);
    }
  };

  // Don't show panel if entity already has signed 8821 and is past pending stage
  if (entity.signed_8821_url && !['pending', 'submitted', '8821_sent'].includes(entity.status)) {
    return null;
  }

  return (
    <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <h4 className="text-sm font-semibold text-indigo-800">Form 8821 — Tax Information Authorization</h4>
      </div>

      {/* Template Downloads */}
      <div className="mb-4">
        <p className="text-xs text-gray-600 mb-2">
          Download the pre-formatted ModernTax 8821 template to include in your DocuSign or signature packet:
        </p>
        <div className="flex flex-wrap gap-2">
          <a
            href={TEMPLATE_INDIVIDUAL}
            download="ModernTax-8821-Individual.pdf"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-indigo-300 text-indigo-700 rounded-lg hover:bg-indigo-100 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            8821 Individual (1040)
          </a>
          <a
            href={TEMPLATE_BUSINESS}
            download="ModernTax-8821-Business.pdf"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-indigo-300 text-indigo-700 rounded-lg hover:bg-indigo-100 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            8821 Business (1065/1120/1120S)
          </a>
        </div>
        <p className="text-xs text-gray-400 mt-1.5">
          Recommended for this entity: <strong>{templateLabel}</strong>
        </p>
      </div>

      {/* Divider */}
      <div className="border-t border-indigo-200 my-3" />

      {/* Upload Signed 8821 */}
      <div>
        <p className="text-xs text-gray-600 mb-2">
          {entity.signed_8821_url
            ? 'Replace the existing signed 8821 with a new version:'
            : 'Upload the signed 8821 once your borrower has completed it:'}
        </p>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".pdf"
            className="text-xs text-gray-600 file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-indigo-300 file:text-xs file:font-medium file:bg-white file:text-indigo-700 hover:file:bg-indigo-50"
          />
          <button
            onClick={handleUpload}
            disabled={uploading}
            className="px-4 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 whitespace-nowrap"
          >
            {uploading ? 'Uploading...' : entity.signed_8821_url ? 'Replace 8821' : 'Upload Signed 8821'}
          </button>
        </div>

        {message && (
          <p className={`text-xs mt-2 ${message.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
            {message.text}
          </p>
        )}

        {!entity.signed_8821_url && (
          <p className="text-xs text-indigo-500 mt-2">
            Once uploaded, the entity status will automatically advance to <strong>8821 Signed</strong> and be queued for IRS processing.
          </p>
        )}
      </div>
    </div>
  );
}
