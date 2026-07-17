'use client';

/**
 * Upload a signed 8821 from any other vendor (Tax Guard, Wolters Kluwer,
 * Avantax, scanned/photo, etc.) → vision-extracts the taxpayer info →
 * lets the manager review/correct → downloads a fresh 8821 with
 * ModernTax (Matt Parker, CAF 0316-30210R) as the designee, pre-filled
 * with Section 1 and Section 3, ready for the client to e-sign.
 *
 * No DB writes happen here. Once the new 8821 is signed by the borrower
 * the manager loops back via /new/pdf (Signed 8821 PDF upload) — same
 * flow they already know — to create the actual transcript order.
 */

import { useState, useRef } from 'react';
import { Download8821Button } from '@/components/Download8821Button';

interface ExtractedTaxpayer {
  taxpayer_name: string | null;
  street_address: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  tin: string | null;
  tin_kind: 'EIN' | 'SSN' | null;
  taxpayer_phone: string | null;
  signer_name: string | null;
  signer_title: string | null;
  signer_email: string | null;
  signed_date: string | null;
  existing_designees: { name: string | null; caf: string | null }[];
  form_types_authorized: string | null;
  years_authorized: string | null;
  notes: string | null;
  source: 'vision' | 'fallback';
  warnings: string[];
}

type UiState = 'idle' | 'extracting' | 'review' | 'generating' | 'done';

export function ConvertVendor8821Flow() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uiState, setUiState] = useState<UiState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [sourcePdfUrl, setSourcePdfUrl] = useState<string | null>(null);
  const [sourceFilename, setSourceFilename] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<ExtractedTaxpayer | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  // Editable form (initialized from extracted, but user can override)
  const [form, setForm] = useState({
    taxpayer_name: '',
    street_address: '',
    city: '',
    state: '',
    zip_code: '',
    tin: '',
    tin_kind: 'EIN' as 'EIN' | 'SSN',
    taxpayer_phone: '',
    form_type: '1120' as '1040' | '1065' | '1120' | '1120S' | '941',
    years: '2022-2026',
  });

  async function handleUpload(file: File) {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setError('Please upload a PDF file.');
      return;
    }
    setError(null);
    setUiState('extracting');
    setSourceFilename(file.name);

    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/manager/convert-8821/extract', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Extraction failed');
        setUiState('idle');
        return;
      }
      const ex: ExtractedTaxpayer = data.extracted;
      setExtracted(ex);
      setSourcePdfUrl(data.sourcePdfUrl || null);
      setWarnings(ex.warnings || []);
      setForm({
        taxpayer_name: ex.taxpayer_name || '',
        street_address: ex.street_address || '',
        city: ex.city || '',
        state: ex.state || '',
        zip_code: ex.zip_code || '',
        tin: ex.tin || '',
        tin_kind: ex.tin_kind || 'EIN',
        taxpayer_phone: ex.taxpayer_phone || '',
        form_type: '1120',
        years: ex.years_authorized || '2022-2026',
      });
      setUiState('review');
    } catch (err: any) {
      setError(err?.message || 'Network error');
      setUiState('idle');
    }
  }

  async function handleGenerate() {
    if (!form.taxpayer_name.trim()) { setError('Taxpayer name required'); return; }
    if (!form.tin.trim()) { setError('TIN required'); return; }
    setError(null);
    setUiState('generating');
    try {
      const res = await fetch('/api/manager/convert-8821/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        let msg = `Generation failed (${res.status})`;
        try { const j = await res.json(); if (j.error) msg = j.error; } catch {}
        setError(msg);
        setUiState('review');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `8821-ModernTax-${form.taxpayer_name.replace(/[^\w]+/g, '-').slice(0, 40)}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setUiState('done');
    } catch (err: any) {
      setError(err?.message || 'Network error during download');
      setUiState('review');
    }
  }

  function startOver() {
    setUiState('idle');
    setExtracted(null);
    setSourcePdfUrl(null);
    setSourceFilename(null);
    setWarnings([]);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>
      )}

      {uiState === 'idle' && (
        <div
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-gray-300 hover:border-mt-green rounded-xl p-12 text-center cursor-pointer bg-gray-50"
        >
          <svg className="mx-auto w-12 h-12 text-gray-400 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <p className="text-sm font-medium text-mt-dark mb-1">Upload a signed 8821 from another vendor</p>
          <p className="text-xs text-gray-500">Tax Guard, Wolters Kluwer, Avantax, scanned, photographed — we&apos;ll read it and rebuild it with ModernTax as the designee.</p>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }}
            className="hidden"
          />
        </div>
      )}

      {uiState === 'extracting' && (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <div className="animate-spin mx-auto w-8 h-8 border-2 border-mt-green border-t-transparent rounded-full mb-3" />
          <p className="text-sm font-medium text-mt-dark">Reading the 8821…</p>
          <p className="text-xs text-gray-500 mt-1">Extracting taxpayer info, signer, designees, and tax years. Usually 5-10 seconds.</p>
        </div>
      )}

      {(uiState === 'review' || uiState === 'generating' || uiState === 'done') && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Left: source PDF preview */}
          <div className="lg:col-span-2">
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
                <div className="text-xs font-medium text-gray-700 truncate">📎 {sourceFilename}</div>
                <button onClick={startOver} className="text-xs text-mt-green hover:underline">Upload different</button>
              </div>
              {sourcePdfUrl ? (
                <iframe src={sourcePdfUrl} className="w-full" style={{ height: '720px' }} title="Source 8821" />
              ) : (
                <div className="p-8 text-center text-xs text-gray-500 italic">Preview unavailable.</div>
              )}
            </div>
            {extracted?.source === 'fallback' && (
              <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
                Auto-extraction wasn&apos;t available — type the fields in manually on the right.
              </div>
            )}
          </div>

          {/* Right: editable form */}
          <div className="lg:col-span-3 space-y-5">
            {warnings.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 space-y-1">
                {warnings.map((w, i) => <div key={i}>⚠️ {w}</div>)}
              </div>
            )}

            {extracted && extracted.existing_designees.length > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-900">
                <div className="font-semibold mb-1">Existing designees on this 8821:</div>
                <ul className="space-y-0.5">
                  {extracted.existing_designees.map((d, i) => (
                    <li key={i}>• {d.name || '(unnamed)'} {d.caf ? <span className="text-blue-700 font-mono">· CAF {d.caf}</span> : null}</li>
                  ))}
                </ul>
                <div className="mt-1 text-blue-700">The new 8821 will REPLACE these with ModernTax (Matt Parker · CAF 0316-30210R) as the primary designee.</div>
              </div>
            )}

            <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-semibold text-mt-dark">Section 1 — Taxpayer</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Legal name <span className="text-red-500">*</span></label>
                  <input type="text" value={form.taxpayer_name}
                    onChange={(e) => setForm({ ...form, taxpayer_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-mt-green outline-none"/>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">TIN <span className="text-red-500">*</span></label>
                  <input type="text" value={form.tin}
                    onChange={(e) => setForm({ ...form, tin: e.target.value })}
                    placeholder="XX-XXXXXXX or XXX-XX-XXXX"
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-mt-green outline-none"/>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">TIN kind</label>
                  <select value={form.tin_kind}
                    onChange={(e) => setForm({ ...form, tin_kind: e.target.value as 'EIN' | 'SSN' })}
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-mt-green outline-none">
                    <option value="EIN">EIN (business)</option>
                    <option value="SSN">SSN / ITIN (individual)</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Street address</label>
                  <input type="text" value={form.street_address}
                    onChange={(e) => setForm({ ...form, street_address: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-mt-green outline-none"/>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">City</label>
                  <input type="text" value={form.city}
                    onChange={(e) => setForm({ ...form, city: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-mt-green outline-none"/>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">State</label>
                    <input type="text" value={form.state} maxLength={2}
                      onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase() })}
                      className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-mt-green outline-none"/>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">ZIP</label>
                    <input type="text" value={form.zip_code}
                      onChange={(e) => setForm({ ...form, zip_code: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-mt-green outline-none"/>
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Daytime phone</label>
                  <input type="text" value={form.taxpayer_phone}
                    onChange={(e) => setForm({ ...form, taxpayer_phone: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-mt-green outline-none"/>
                </div>
              </div>
            </div>

            <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-semibold text-mt-dark">Section 3 — Tax matters</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Form</label>
                  <select value={form.form_type}
                    onChange={(e) => setForm({ ...form, form_type: e.target.value as any })}
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-mt-green outline-none">
                    <option value="1040">1040 (individual)</option>
                    <option value="1065">1065 (partnership)</option>
                    <option value="1120">1120 (C-corp)</option>
                    <option value="1120S">1120S (S-corp)</option>
                    <option value="941">941 (payroll)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tax years</label>
                  <input type="text" value={form.years}
                    onChange={(e) => setForm({ ...form, years: e.target.value })}
                    placeholder="e.g. 2022-2026 or 2024,2025"
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-mt-green outline-none"/>
                </div>
              </div>
              <p className="text-xs text-gray-500 italic">
                Designee on the new 8821: <span className="font-semibold">Matthew Parker C/O ModernTax Inc</span> · CAF <span className="font-mono">0316-30210R</span>
              </p>
            </div>

            <div className="flex items-center justify-between">
              <button
                onClick={startOver}
                className="text-sm text-gray-600 hover:text-mt-dark"
              >
                ← Upload a different 8821
              </button>
              <button
                onClick={handleGenerate}
                disabled={uiState === 'generating' || !form.taxpayer_name.trim() || !form.tin.trim()}
                className="px-5 py-2.5 bg-mt-dark text-white text-sm font-semibold rounded-lg hover:bg-mt-dark/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {uiState === 'generating' ? (
                  <>
                    <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                    Generating…
                  </>
                ) : uiState === 'done' ? (
                  <>✓ Downloaded — Regenerate</>
                ) : (
                  <>Generate ModernTax 8821 →</>
                )}
              </button>
            </div>

            {uiState === 'done' && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 text-sm text-emerald-800">
                <div className="font-semibold mb-1">✓ New 8821 downloaded</div>
                <div className="text-xs">Forward it to <strong>{extracted?.signer_name || 'the taxpayer'}</strong>{extracted?.signer_email ? <> at <span className="font-mono">{extracted.signer_email}</span></> : null} for signature. Once signed, return here via <a href="/new/pdf" className="underline">Signed 8821 PDF upload</a> to create the transcript request.</div>
                <div className="mt-3">
                  <Download8821Button
                    label="Email me a copy"
                    entityName={form.taxpayer_name}
                    tid={form.tin}
                    formType={form.form_type}
                    years={form.years}
                    address={form.street_address}
                    city={form.city}
                    state={form.state}
                    zipCode={form.zip_code}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
