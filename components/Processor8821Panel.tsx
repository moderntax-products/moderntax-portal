'use client';

import { useState, useRef } from 'react';

interface Entity {
  id: string;
  entity_name: string;
  form_type: string;
  status: string;
  signed_8821_url: string | null;
  signer_email: string | null;
  years?: string[] | null;
  tid_kind?: 'SSN' | 'EIN' | null;
}

interface Processor8821PanelProps {
  entity: Entity;
  requestId: string;
}

// 941 added May 2026 for ERC verification workflows. (Notes-required
// UX for non-standard forms is implemented in CsvUploadFlow; ported
// here in a follow-up if needed — this panel is lower-volume.)
const FORM_TYPE_OPTIONS = ['1040', '1065', '1120', '1120S', '941', '990', '1041', 'W2_INCOME'] as const;

/**
 * Parse a free-text year input into a normalized array of YYYY strings.
 * Accepts comma-separated lists ("2021, 2022, 2023"), ranges ("2021-2024"),
 * mixed ("2019, 2021-2023, 2024"), or a single year ("2023").
 * Returns { years, errors } — errors is non-empty if any token failed validation.
 */
function parseYearsInput(raw: string): { years: string[]; errors: string[] } {
  const errors: string[] = [];
  const years = new Set<string>();
  const currentYear = new Date().getFullYear();
  const tokens = raw.split(/[,;\n]+/).map(t => t.trim()).filter(Boolean);
  for (const token of tokens) {
    const rangeMatch = token.match(/^(\d{4})\s*[-–—to]+\s*(\d{4})$/i);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start > end) { errors.push(`Range "${token}" is reversed (start > end).`); continue; }
      if (start < 1990 || end > currentYear + 1) {
        errors.push(`Range "${token}" outside 1990-${currentYear + 1}.`);
        continue;
      }
      for (let y = start; y <= end; y++) years.add(String(y));
      continue;
    }
    const singleMatch = token.match(/^(\d{4})$/);
    if (singleMatch) {
      const y = parseInt(singleMatch[1], 10);
      if (y < 1990 || y > currentYear + 1) {
        errors.push(`Year "${token}" outside 1990-${currentYear + 1}.`);
        continue;
      }
      years.add(String(y));
      continue;
    }
    errors.push(`Could not parse "${token}" — use 2021, 2022 or 2021-2024.`);
  }
  return { years: Array.from(years).sort(), errors };
}

export function Processor8821Panel({ entity, requestId: _requestId }: Processor8821PanelProps) {
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [savingMeta, setSavingMeta] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Editable metadata — pre-populated from the entity, but the processor can fix
  // any of these BEFORE (or AFTER) uploading the signed 8821. This is the only
  // place in the app today where years can be edited post-intake.
  //
  // Form-type default: if the entity doesn't have one yet, infer from tid_kind
  // so an EIN entity doesn't silently show '1040' (the bug behind 116 rows in
  // production). Processors can still override, but the server rejects an
  // incompatible combination.
  const inferredDefaultForm = entity.tid_kind === 'EIN' ? '1120' : '1040';
  const [yearsInput, setYearsInput] = useState((entity.years || []).join(', '));
  const [formType, setFormType] = useState<string>(entity.form_type || inferredDefaultForm);
  const [yearsErrors, setYearsErrors] = useState<string[]>([]);
  // Borrower email — manual fallback for the case where the uploaded PDF was
  // flattened (no DocuSign Certificate of Completion) so server-side extraction
  // can't find the signer email. Pre-populated from the entity if already set.
  const [borrowerEmail, setBorrowerEmail] = useState<string>(entity.signer_email || '');
  const [borrowerEmailDirty, setBorrowerEmailDirty] = useState(false);
  // After upload, if the API confirms no email was found anywhere, surface a
  // visible nudge under the field so the processor knows to fill it.
  const [needsManualEmail, setNeedsManualEmail] = useState(false);

  // Client-side guard mirroring the server validation — shows an inline
  // warning if the current form_type is incompatible with tid_kind.
  const tidFormMismatch: string | null = (() => {
    if (!entity.tid_kind || !formType) return null;
    const businessForms = new Set(['1065', '1120', '1120S', '990', '1041']);
    const individualForms = new Set(['1040', 'W2_INCOME']);
    if (entity.tid_kind === 'EIN' && individualForms.has(formType)) {
      return `This entity has an EIN (business). Use 1065, 1120, or 1120S — not ${formType}.`;
    }
    if (entity.tid_kind === 'SSN' && businessForms.has(formType)) {
      return `This entity has an SSN (individual). Use 1040 — not ${formType}.`;
    }
    return null;
  })();

  const isIndividual = formType === '1040';
  const templateLabel = isIndividual ? 'Individual (1040)' : 'Business (1065/1120/1120S)';

  const yearsAreEmpty = !entity.years || entity.years.length === 0;
  const yearsAreDirty = yearsInput.trim() !== (entity.years || []).join(', ');
  const formTypeIsDirty = formType !== entity.form_type;
  // Simple client-side email validity (server re-validates with the same rule).
  const trimmedEmail = borrowerEmail.trim();
  const borrowerEmailValid = !trimmedEmail || /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(trimmedEmail);

  const handleSaveMetadata = async (opts: { silent?: boolean } = {}): Promise<boolean> => {
    const { years: parsedYears, errors } = parseYearsInput(yearsInput);
    setYearsErrors(errors);
    if (errors.length > 0) {
      if (!opts.silent) setMessage({ type: 'error', text: 'Fix the year input before saving.' });
      return false;
    }
    if (parsedYears.length === 0) {
      if (!opts.silent) setMessage({ type: 'error', text: 'Enter at least one year (e.g. 2021-2024).' });
      return false;
    }
    if (tidFormMismatch) {
      if (!opts.silent) setMessage({ type: 'error', text: tidFormMismatch });
      return false;
    }

    setSavingMeta(true);
    try {
      const res = await fetch('/api/admin/upload-8821', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityId: entity.id,
          years: parsedYears,
          formType,
          // Only send borrowerEmail when the processor edited it AND it's valid —
          // sending an empty/invalid value would either no-op or 400 on the server.
          ...(borrowerEmailDirty && borrowerEmailValid && trimmedEmail
            ? { borrowerEmail: trimmedEmail }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error || 'Failed to save entity details' });
        return false;
      }
      if (!opts.silent) {
        setMessage({ type: 'success', text: 'Entity details saved.' });
        setTimeout(() => window.location.reload(), 800);
      }
      return true;
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Save failed' });
      return false;
    } finally {
      setSavingMeta(false);
    }
  };

  // Download the per-entity pre-filled 8821. Reflects the form type + years
  // currently shown in the panel (passed as query overrides) so the processor
  // doesn't have to "save" first just to get an up-to-date PDF.
  const handleDownloadPrefilled = async () => {
    if (tidFormMismatch) {
      setMessage({ type: 'error', text: tidFormMismatch });
      return;
    }
    setDownloading(true);
    setMessage(null);
    try {
      const params = new URLSearchParams({ entityId: entity.id, formType });
      const { years: parsedYears } = parseYearsInput(yearsInput);
      if (parsedYears.length > 0) params.set('years', parsedYears.join(','));

      const res = await fetch(`/api/entity/8821-prefill?${params.toString()}`);
      if (!res.ok) {
        let detail = 'Failed to generate the pre-filled 8821.';
        try { const j = await res.json(); detail = j.error || j.detail || detail; } catch { /* non-JSON */ }
        setMessage({ type: 'error', text: detail });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safe = (entity.entity_name || 'entity').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40);
      a.download = `8821-${safe}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Download failed' });
    } finally {
      setDownloading(false);
    }
  };

  // Pre-filled Form 2848 (Power of Attorney) download. Unlike the 8821 it needs
  // no form-type/year inputs — the route derives Section 3 from the entity and
  // uses the generic ModernTax representative (blank CAF, Part II left blank).
  const handleDownload2848 = async () => {
    setDownloading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/entity/2848-prefill?entityId=${encodeURIComponent(entity.id)}`);
      if (!res.ok) {
        let detail = 'Failed to generate the pre-filled 2848.';
        try { const j = await res.json(); detail = j.error || j.detail || detail; } catch { /* non-JSON */ }
        setMessage({ type: 'error', text: detail });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safe = (entity.entity_name || 'entity').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40);
      a.download = `2848-${safe}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Download failed' });
    } finally {
      setDownloading(false);
    }
  };

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

    // Hard-block upload if years are missing or invalid — this is the bug we're
    // fixing: signed 8821s were being uploaded with no year(s) on the entity, so
    // the experts had no idea which periods to request from the IRS.
    const { years: parsedYears, errors } = parseYearsInput(yearsInput);
    setYearsErrors(errors);
    if (errors.length > 0) {
      setMessage({ type: 'error', text: 'Fix the year input before uploading.' });
      return;
    }
    if (parsedYears.length === 0) {
      setMessage({ type: 'error', text: 'Enter year(s) covered by this 8821 (e.g. 2021-2024) before uploading.' });
      return;
    }
    if (tidFormMismatch) {
      setMessage({ type: 'error', text: tidFormMismatch });
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
      formData.append('entityId', entity.id);
      formData.append('file', file);
      formData.append('years', parsedYears.join(','));
      formData.append('formType', formType);
      // Only send borrowerEmail when the processor actually entered one — empty
      // string would clobber a legitimate intake-supplied value on the server.
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

      // Inspect the extraction result so the processor knows whether they
      // need to add the borrower email manually before refreshing.
      const x = data.emailExtraction;
      if (x?.needsManualEntry) {
        // No email anywhere — keep the panel open, surface a clear nudge,
        // skip the auto-refresh so they can fill in the borrower email and
        // PATCH it through the "Save Entity Details" button.
        setNeedsManualEmail(true);
        setMessage({
          type: 'success',
          text: 'Signed 8821 uploaded. We could not detect a borrower email in the PDF — please add it below so the borrower auto-enrolls in compliance updates.',
        });
        if (fileRef.current) fileRef.current.value = '';
        return;
      }

      const sourceLabel =
        x?.signerEmailSource === 'manual'
          ? 'using your entered borrower email'
          : x?.signerEmailSource === 'extraction'
            ? `borrower email auto-extracted from PDF (${x?.finalSignerEmail || ''})`
            : '';
      setMessage({
        type: 'success',
        text: `Signed 8821 uploaded! Entity status updated to 8821 Signed${sourceLabel ? ' — ' + sourceLabel : ''}.`,
      });
      if (fileRef.current) fileRef.current.value = '';
      // Refresh page after short delay to show updated status
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Upload failed' });
    } finally {
      setUploading(false);
    }
  };

  // Always render if years are missing — even after the 8821 has been uploaded —
  // because the processor still needs to fix that data. Otherwise keep the original
  // gating logic (only show panel during early statuses or pre-upload).
  const stageAllowsUpload = ['pending', 'submitted', '8821_sent'].includes(entity.status);
  if (entity.signed_8821_url && !stageAllowsUpload && !yearsAreEmpty) {
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

      {/* Pre-filled 8821 download — generated per-entity */}
      <div className="mb-4">
        <p className="text-xs text-gray-600 mb-2">
          Download the 8821 pre-filled with <strong>{entity.entity_name || 'this entity'}</strong>&rsquo;s
          information (name, TIN, address) — ModernTax is already listed as the designee.
          Send it to the borrower to sign, then upload the signed copy below:
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleDownloadPrefilled}
            disabled={downloading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-indigo-300 text-indigo-700 rounded-lg hover:bg-indigo-100 transition-colors disabled:opacity-50"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {downloading ? 'Generating…' : `Download Pre-filled 8821 — ${templateLabel}`}
          </button>
          <button
            type="button"
            onClick={handleDownload2848}
            disabled={downloading}
            title="Power of Attorney — taxpayer info pre-filled, generic ModernTax representative (CAF + Part II completed at signing)"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-indigo-300 text-indigo-700 rounded-lg hover:bg-indigo-100 transition-colors disabled:opacity-50"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {downloading ? 'Generating…' : 'Download Pre-filled 2848 (POA)'}
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-1.5">
          Form type: <strong>{templateLabel}</strong>. Change the form type below if this is wrong before downloading.
        </p>
      </div>

      {/* Divider */}
      <div className="border-t border-indigo-200 my-3" />

      {/* Entity Details — Years + Form Type */}
      {/* These fields drive what the expert requests from the IRS. Required before
          (or alongside) uploading the signed 8821. Pre-populated from intake. */}
      <div className="mb-4">
        <p className="text-xs text-gray-700 font-semibold mb-2">
          Entity details
          {yearsAreEmpty && (
            <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-bold text-red-700 bg-red-100 border border-red-200 rounded px-1.5 py-0.5">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              Years missing
            </span>
          )}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div className="sm:col-span-2">
            <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">
              Year(s) or period(s) — required
            </label>
            <input
              type="text"
              value={yearsInput}
              onChange={(e) => { setYearsInput(e.target.value); setYearsErrors([]); }}
              placeholder="e.g. 2021-2024 or 2021, 2022, 2023"
              className={`w-full px-2.5 py-1.5 text-xs border rounded-lg bg-white ${
                yearsErrors.length > 0 || yearsAreEmpty
                  ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
                  : 'border-indigo-300 focus:border-indigo-500 focus:ring-indigo-500'
              } focus:outline-none focus:ring-1`}
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">
              Form type
            </label>
            <select
              value={formType}
              onChange={(e) => setFormType(e.target.value)}
              className="w-full px-2.5 py-1.5 text-xs border border-indigo-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:border-indigo-500 focus:ring-indigo-500"
            >
              {FORM_TYPE_OPTIONS.map(opt => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          </div>
        </div>

        {yearsErrors.length > 0 && (
          <ul className="mt-1.5 text-[11px] text-red-700 list-disc list-inside space-y-0.5">
            {yearsErrors.map((err, i) => <li key={i}>{err}</li>)}
          </ul>
        )}

        {tidFormMismatch && (
          <div className="mt-1.5 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
            <strong>Form mismatch:</strong> {tidFormMismatch}
          </div>
        )}

        <p className="mt-1.5 text-[10px] text-gray-500">
          Enter a range like <code className="font-mono bg-white px-1 rounded">2021-2024</code> or a list like
          <code className="font-mono bg-white px-1 rounded ml-1">2021, 2022, 2023</code>. These map to the
          &ldquo;Year(s) or Period(s)&rdquo; field on Form 8821 and tell the expert which transcripts to pull.
        </p>

        {/* Borrower email — manual fallback for the 8821 PDF extractor. We try to
            read the signer's email from the uploaded PDF (DocuSign Certificate of
            Completion → Signer Events), but flattened PDFs strip that page. When
            extraction returns nothing, this field is the source of truth. */}
        <div className="mt-3">
          <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">
            Borrower email
            <span className="ml-1 text-gray-400 normal-case">
              (taxpayer who signed — for transcript follow-ups + compliance updates)
            </span>
          </label>
          <input
            type="email"
            value={borrowerEmail}
            onChange={(e) => { setBorrowerEmail(e.target.value); setBorrowerEmailDirty(true); setNeedsManualEmail(false); }}
            placeholder="e.g. owner@gmail.com"
            className={`w-full px-2.5 py-1.5 text-xs border rounded-lg bg-white focus:outline-none focus:ring-1 ${
              !borrowerEmailValid
                ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
                : needsManualEmail
                  ? 'border-amber-400 focus:border-amber-500 focus:ring-amber-500'
                  : 'border-indigo-300 focus:border-indigo-500 focus:ring-indigo-500'
            }`}
          />
          {!borrowerEmailValid && (
            <p className="mt-1 text-[11px] text-red-700">Not a valid email address.</p>
          )}
          {needsManualEmail && borrowerEmailValid && (
            <p className="mt-1 text-[11px] text-amber-700">
              Couldn&rsquo;t detect a borrower email in the PDF (Certificate of Completion missing). Please paste it from the DocuSign envelope, then click <strong>Save Entity Details</strong>.
            </p>
          )}
          {!needsManualEmail && (
            <p className="mt-1 text-[10px] text-gray-500">
              Optional — if left blank, we&rsquo;ll try to read it from the uploaded PDF. Manually-entered values always win over PDF extraction.
            </p>
          )}
        </div>

        {/* Save-only button (no upload) — useful when 8821 is already signed but
            years/form-type/borrower-email were never set, like the Burger51 case. */}
        {entity.signed_8821_url && (yearsAreDirty || formTypeIsDirty || (borrowerEmailDirty && borrowerEmailValid)) && (
          <div className="mt-2">
            <button
              onClick={() => handleSaveMetadata()}
              disabled={savingMeta}
              className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {savingMeta ? 'Saving…' : 'Save Entity Details'}
            </button>
          </div>
        )}
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
            disabled={uploading || savingMeta}
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
