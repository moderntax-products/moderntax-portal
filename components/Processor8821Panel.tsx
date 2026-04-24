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

const TEMPLATE_INDIVIDUAL = '/templates/8821-individual.pdf';
const TEMPLATE_BUSINESS = '/templates/8821-business.pdf';

const FORM_TYPE_OPTIONS = ['1040', '1065', '1120', '1120S'] as const;

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

    setUploading(true);
    setMessage(null);

    try {
      const formData = new FormData();
      formData.append('entityId', entity.id);
      formData.append('file', file);
      formData.append('years', parsedYears.join(','));
      formData.append('formType', formType);

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

        {/* Save-only button (no upload) — useful when 8821 is already signed but
            years/form-type were never set, like the Burger51 case. */}
        {entity.signed_8821_url && (yearsAreDirty || formTypeIsDirty) && (
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
