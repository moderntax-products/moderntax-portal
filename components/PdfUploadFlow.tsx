'use client';

/**
 * PdfUploadFlow — extracted from app/new/page.tsx (PdfUploadTab) so the
 * signed-8821 PDF intake workflow can live at /new/pdf for analytics
 * tracking. Identical behavior to the prior tabbed version.
 */

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';

const ENTITY_TRANSCRIPT_PRICE = 0; // free — entity verification included on every order (2026-07-17)

export function PdfUploadFlow() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [loanNumber, setLoanNumber] = useState('');
  const [entityName, setEntityName] = useState('');
  const [tid, setTid] = useState('');
  const [tidKind, setTidKind] = useState<'EIN' | 'SSN'>('EIN');
  const [formType, setFormType] = useState('1040');
  const [years, setYears] = useState(String(new Date().getFullYear()));
  // Taxpayer contact + mailing address — REQUIRED. We no longer rely on parsing
  // them off the uploaded 8821 (that fails on flattened/scanned forms, leaving
  // the entity — and any regenerated 8821's Line 1 — with a blank address).
  const [signerFirstName, setSignerFirstName] = useState('');
  const [signerLastName, setSignerLastName] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [stateRegion, setStateRegion] = useState('');
  const [zipCode, setZipCode] = useState('');
  // Attestation: the name/address/SSN-EIN on the uploaded 8821 are TYPED &
  // legible (only the signature is handwritten). Required before submit.
  const [attestLegible, setAttestLegible] = useState(false);
  const [notes, setNotes] = useState('');
  const [entityTranscript, setEntityTranscript] = useState(false);
  // Filing-Compliance Report order (MOD-228 Phase 2): account transcript only.
  const [filingCompliance, setFilingCompliance] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    setFiles(selected);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (files.length === 0) { setError('Please select at least one PDF file'); return; }
    if (!loanNumber.trim()) { setError('Loan number is required'); return; }
    if (!entityName.trim()) { setError('Entity name is required'); return; }
    if (!tid.trim()) { setError('Tax ID is required'); return; }
    if (!signerFirstName.trim()) { setError('Signee first name is required'); return; }
    if (!signerLastName.trim()) { setError('Signee last name is required'); return; }
    if (!signerEmail.trim()) { setError('Taxpayer email is required'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(signerEmail.trim())) { setError('Enter a valid taxpayer email'); return; }
    if (!address.trim()) { setError('Taxpayer street address is required'); return; }
    if (!city.trim()) { setError('Taxpayer city is required'); return; }
    if (!stateRegion.trim()) { setError('Taxpayer state is required'); return; }
    if (!zipCode.trim()) { setError('Taxpayer ZIP is required'); return; }
    if (!attestLegible) { setError('Please confirm the name, address, and SSN/EIN on the 8821 are typed and legible'); return; }

    setIsLoading(true);

    try {
      const formData = new FormData();
      files.forEach((f) => formData.append('files', f));
      formData.append('loan_number', loanNumber.trim());
      formData.append('entity_name', entityName.trim());
      formData.append('tid', tid.trim());
      formData.append('tid_kind', tidKind);
      formData.append('form_type', formType);
      formData.append('years', years);
      formData.append('signer_first_name', signerFirstName.trim());
      formData.append('signer_last_name', signerLastName.trim());
      formData.append('signer_email', signerEmail.trim());
      formData.append('address', address.trim());
      formData.append('city', city.trim());
      formData.append('state', stateRegion.trim());
      formData.append('zip_code', zipCode.trim());
      if (entityTranscript) formData.append('entity_transcript', 'true');
      if (filingCompliance) formData.append('filing_compliance', 'true');
      if (notes) formData.append('notes', notes);

      const res = await fetch('/api/upload/pdf', { method: 'POST', body: formData });
      const data = await res.json();

      if (!res.ok) { setError(data.error || 'Upload failed'); return; }

      setSuccess(true);
      setRequestId(data.request_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsLoading(false);
    }
  };

  if (success && requestId) {
    return (
      <div className="bg-white rounded-lg shadow p-8 text-center">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-mt-dark mb-2">PDF Upload Complete</h2>
        <p className="text-gray-600 mb-6">
          Signed 8821 uploaded for <strong>{entityName}</strong> (Loan #{loanNumber})
        </p>
        <div className="flex gap-4 justify-center">
          <button onClick={() => router.push(`/request/${requestId}`)}
            className="bg-mt-green text-white px-6 py-3 rounded-lg font-semibold hover:bg-opacity-90 transition-colors">
            View Request
          </button>
          <button onClick={() => router.push('/')}
            className="px-6 py-3 border border-gray-300 rounded-lg font-semibold text-gray-600 hover:bg-gray-50 transition-colors">
            Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-700 text-sm">{error}</p>
        </div>
      )}

      <div className="bg-white rounded-lg shadow p-8">
        <h2 className="text-xl font-bold text-mt-dark mb-2">Upload Signed 8821 PDF</h2>
        <p className="text-gray-500 text-sm mb-6">Upload a pre-signed IRS Form 8821 (Tax Information Authorization) PDF.</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <div>
            <label className="block text-sm font-semibold text-mt-dark mb-2">Loan / Application Number <span className="text-red-500">*</span></label>
            <input type="text" value={loanNumber} onChange={(e) => setLoanNumber(e.target.value)} placeholder="e.g., 12345" disabled={isLoading}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-mt-dark mb-2">Entity / Legal Name <span className="text-red-500">*</span></label>
            <input type="text" value={entityName} onChange={(e) => setEntityName(e.target.value)} placeholder="Business or individual name" disabled={isLoading}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-mt-dark mb-2">Tax ID <span className="text-red-500">*</span></label>
            <div className="flex gap-3">
              <select value={tidKind} onChange={(e) => setTidKind(e.target.value as 'EIN' | 'SSN')} disabled={isLoading}
                className="px-3 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50">
                <option value="EIN">EIN</option>
                <option value="SSN">SSN</option>
              </select>
              <input type="text" value={tid} onChange={(e) => setTid(e.target.value)}
                placeholder={tidKind === 'EIN' ? 'XX-XXXXXXX' : 'XXX-XX-XXXX'} disabled={isLoading}
                className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 font-mono" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold text-mt-dark mb-2">Form Type</label>
            <select value={formType} onChange={(e) => setFormType(e.target.value)} disabled={isLoading}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50">
              <option value="1040">1040 (Individual)</option>
              <option value="1065">1065 (Partnership)</option>
              <option value="1120">1120 (Corporation)</option>
              <option value="1120S">1120S (S-Corp)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold text-mt-dark mb-2">Tax Years</label>
            <input type="text" value={years} onChange={(e) => setYears(e.target.value)}
              placeholder={`e.g., ${new Date().getFullYear()}, ${new Date().getFullYear() - 1}, ${new Date().getFullYear() - 2}`} disabled={isLoading}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
            <p className="text-xs text-gray-500 mt-1">Comma-separated years</p>
          </div>
        </div>

        {/* Taxpayer contact + mailing address — REQUIRED. Captured here (not
            parsed off the 8821) so it's reliable even on scanned/handwritten
            forms, and so a regenerated 8821 has a complete Line 1. */}
        <div className="border border-gray-200 rounded-lg p-4 mb-6 bg-gray-50">
          <p className="text-sm font-semibold text-mt-dark mb-1">Signee taxpayer &amp; mailing address <span className="text-red-500">*</span></p>
          <p className="text-xs text-gray-500 mb-3">Enter the signee taxpayer&apos;s name, email, and address exactly as they appear on the 8821 — these populate Form 8821 Line 1 and our notifications. Type them; don&apos;t rely on the scanned form.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Signee first name <span className="text-red-500">*</span></label>
              <input type="text" value={signerFirstName} onChange={(e) => setSignerFirstName(e.target.value)} placeholder="First name" disabled={isLoading}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Signee last name <span className="text-red-500">*</span></label>
              <input type="text" value={signerLastName} onChange={(e) => setSignerLastName(e.target.value)} placeholder="Last name" disabled={isLoading}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">Taxpayer email <span className="text-red-500">*</span></label>
              <input type="email" value={signerEmail} onChange={(e) => setSignerEmail(e.target.value)} placeholder="taxpayer@example.com" disabled={isLoading}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">Street address <span className="text-red-500">*</span></label>
              <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St" disabled={isLoading}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">City <span className="text-red-500">*</span></label>
              <input type="text" value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" disabled={isLoading}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">State <span className="text-red-500">*</span></label>
                <input type="text" value={stateRegion} onChange={(e) => setStateRegion(e.target.value)} placeholder="CA" disabled={isLoading}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">ZIP <span className="text-red-500">*</span></label>
                <input type="text" value={zipCode} onChange={(e) => setZipCode(e.target.value)} placeholder="94111" disabled={isLoading}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
              </div>
            </div>
          </div>
        </div>

        {/* Filing-Compliance Report order (MOD-228 Phase 2) */}
        <div className={`mb-6 border rounded-lg p-4 transition-colors ${filingCompliance ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200 bg-gray-50'}`}>
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={filingCompliance} onChange={() => setFilingCompliance(!filingCompliance)} disabled={isLoading}
              className="w-5 h-5 mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-50" />
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-mt-dark text-sm">Order as Filing-Compliance Report</span>
                <span className="text-indigo-600 font-bold text-sm">$29.99</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">Civil-penalty + filed/unfiled status from the IRS Account Transcript only &mdash; no income/wage transcripts.</p>
            </div>
          </label>
        </div>

        {tidKind === 'EIN' && !filingCompliance && (
          <div className={`mb-6 border rounded-lg p-4 transition-colors ${entityTranscript ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-gray-50'}`}>
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={entityTranscript} onChange={() => setEntityTranscript(!entityTranscript)} disabled={isLoading}
                className="w-5 h-5 mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50" />
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-mt-dark text-sm">Add Entity Transcript</span>
                  <span className="text-blue-600 font-bold text-sm">${ENTITY_TRANSCRIPT_PRICE.toFixed(2)}</span>
                </div>
                <p className="text-xs text-gray-500 mt-1">Confirms IRS filing requirements before pulling income transcripts. Prevents blank results from requesting the wrong form type.</p>
              </div>
            </label>
          </div>
        )}

        <div className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
            files.length > 0 ? 'border-mt-green bg-green-50' : 'border-gray-300 hover:border-gray-400'
          }`}
          onClick={() => fileRef.current?.click()}>
          <input ref={fileRef} type="file" accept=".pdf" multiple onChange={handleFileChange} className="hidden" />
          {files.length > 0 ? (
            <div>
              <svg className="w-12 h-12 text-mt-green mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-mt-dark font-semibold">{files.length} PDF{files.length > 1 ? 's' : ''} selected</p>
              <ul className="text-gray-500 text-sm mt-1">
                {files.map((f) => <li key={f.name}>{f.name} ({(f.size / 1024).toFixed(1)} KB)</li>)}
              </ul>
            </div>
          ) : (
            <div>
              <svg className="w-12 h-12 text-gray-400 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="text-gray-600 font-medium">Click to select signed 8821 PDF(s)</p>
              <p className="text-gray-400 text-sm mt-1">Supports .pdf &middot; Multiple files OK</p>
            </div>
          )}
        </div>

        <div className="mt-6">
          <label className="block text-sm font-semibold text-mt-dark mb-2">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any additional context..." rows={3} disabled={isLoading}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
        </div>

        {/* Legibility attestation — the only handwritten part of the 8821 may be
            the signature. Name / address / SSN-EIN must be typed & legible. */}
        <div className={`mt-6 border rounded-lg p-4 transition-colors ${attestLegible ? 'border-mt-green bg-green-50' : 'border-amber-300 bg-amber-50'}`}>
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={attestLegible} onChange={() => setAttestLegible(!attestLegible)} disabled={isLoading}
              className="w-5 h-5 mt-0.5 rounded border-gray-300 text-mt-green focus:ring-mt-green disabled:opacity-50" />
            <span className="text-sm text-mt-dark">
              I confirm the taxpayer&apos;s <strong>name, address, and SSN/EIN are typed and legible</strong> on this 8821 — only the signature is handwritten. Forms with handwritten or illegible name/address/TIN fields are rejected by the IRS and can&apos;t be processed.
            </span>
          </label>
        </div>
      </div>

      <button type="submit" disabled={isLoading || files.length === 0 || !attestLegible}
        className="w-full bg-mt-green text-white py-4 rounded-lg font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-lg">
        {isLoading ? 'Uploading...' : 'Upload Signed 8821'}
      </button>
    </form>
  );
}
