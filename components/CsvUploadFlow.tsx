'use client';

/**
 * CsvUploadFlow — extracted from app/new/page.tsx (CsvUploadTab) so the
 * batch-upload workflow can live at its own URL (/new/csv) for analytics
 * tracking. Identical behavior to the prior tabbed version: client-side
 * preview parsing → repeat-borrower lookup → preview table → POST to
 * /api/upload/csv → success state with loan numbers + CTA to dashboard.
 */

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import * as XLSX from 'xlsx';

const ENTITY_TRANSCRIPT_PRICE = 19.99;

interface CsvPreviewEntity {
  rowIndex: number;
  legalName: string;
  tid: string;
  tidKind: string;
  formType: string;
  years: string;
  email: string;
  firstName: string;
  lastName: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  entityTranscript: boolean;
  missingFields: string[];
  isRepeat?: boolean;
  repeatOfName?: string;
}

export function CsvUploadFlow() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loanNumber, setLoanNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showColumnRef, setShowColumnRef] = useState(false);
  const [previewEntities, setPreviewEntities] = useState<CsvPreviewEntity[] | null>(null);
  const [result, setResult] = useState<{
    requests_created: number;
    entities_created: number;
    loan_numbers: string[];
    entity_transcripts_ordered?: number;
  } | null>(null);

  const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/\s+/g, '_');

  const parseFileForPreview = useCallback(async (f: File) => {
    try {
      const buffer = await f.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

      const entities: CsvPreviewEntity[] = rawRows.map((raw, idx) => {
        const norm: Record<string, string> = {};
        for (const [key, value] of Object.entries(raw)) {
          norm[normalizeHeader(key)] = String(value ?? '').trim();
        }
        const tidKind = norm['tid_kind'] || norm['tidkind'] || 'EIN';
        const legalName = norm['legal_name'] || norm['legalname'] || '';
        const tid = norm['tid'] || '';
        const email = norm['email'] || norm['signer_email'] || norm['signeremail'] || '';
        const firstName = norm['first_name'] || norm['firstname'] || '';
        const lastName = norm['last_name'] || norm['lastname'] || '';
        const address = norm['address'] || '';
        const city = norm['city'] || '';
        const state = norm['state'] || '';
        const zipCode = norm['zip_code'] || norm['zipcode'] || norm['zip'] || '';
        const years = norm['years'] || norm['year'] || '';

        const missing: string[] = [];
        if (!legalName) missing.push('legal_name');
        if (!tid) missing.push('tid');
        if (!email) missing.push('email');
        if (!firstName) missing.push('first name');
        if (!lastName) missing.push('last name');
        if (!address) missing.push('address');
        if (!city) missing.push('city');
        if (!state) missing.push('state');
        if (!zipCode) missing.push('zip_code');
        if (!years) missing.push('years');

        return {
          rowIndex: idx,
          legalName,
          tid,
          tidKind: ['SSN', 'ITIN'].includes(tidKind.toUpperCase()) ? 'SSN' : 'EIN',
          formType: norm['form'] || norm['form_type'] || norm['formtype'] || '1040',
          years,
          email,
          firstName,
          lastName,
          address,
          city,
          state,
          zipCode,
          entityTranscript: false,
          missingFields: missing,
        };
      });

      setPreviewEntities(entities);

      const tids = entities.map(e => e.tid).filter(Boolean);
      if (tids.length > 0) {
        try {
          const supabase = createClient();
          const { data: existing } = await supabase
            .from('request_entities')
            .select('tid, entity_name')
            .in('tid', tids)
            .not('signed_8821_url', 'is', null) as { data: { tid: string; entity_name: string }[] | null; error: unknown };
          if (existing && existing.length > 0) {
            const repeatByTid = new Map(existing.map(e => [e.tid, e.entity_name]));
            const carveoutFields = new Set(['email', 'first name', 'last name', 'address', 'city', 'state', 'zip_code']);
            setPreviewEntities(prev => (prev || []).map(e => {
              const repeatName = repeatByTid.get(e.tid);
              if (!repeatName) return e;
              return {
                ...e,
                isRepeat: true,
                repeatOfName: repeatName,
                missingFields: e.missingFields.filter(f => !carveoutFields.has(f)),
              };
            }));
          }
        } catch (err) {
          console.warn('[csv-preview] repeat-borrower lookup failed:', err);
        }
      }
    } catch {
      setPreviewEntities(null);
    }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      setError(null);
      setResult(null);
      setPreviewEntities(null);
      parseFileForPreview(f);
    }
  };

  const toggleEntityTranscript = (rowIndex: number) => {
    if (!previewEntities) return;
    setPreviewEntities(previewEntities.map(e =>
      e.rowIndex === rowIndex ? { ...e, entityTranscript: !e.entityTranscript } : e
    ));
  };

  const toggleAllEntityTranscripts = (checked: boolean) => {
    if (!previewEntities) return;
    setPreviewEntities(previewEntities.map(e =>
      e.tidKind === 'EIN' ? { ...e, entityTranscript: checked } : e
    ));
  };

  const entityTranscriptCount = previewEntities?.filter(e => e.entityTranscript).length || 0;
  const einCount = previewEntities?.filter(e => e.tidKind === 'EIN').length || 0;
  const hasValidationErrors = previewEntities?.some(e => e.missingFields.length > 0) || false;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) { setError('Please select a file'); return; }
    if (!loanNumber.trim()) { setError('Loan number is required'); return; }

    setIsLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('loan_number', loanNumber.trim());
      if (notes) formData.append('notes', notes);

      if (previewEntities) {
        const selectedIndices = previewEntities
          .filter(e => e.entityTranscript)
          .map(e => e.rowIndex);
        if (selectedIndices.length > 0) {
          formData.append('entity_transcript_indices', JSON.stringify(selectedIndices));
        }
      }

      const res = await fetch('/api/upload/csv', { method: 'POST', body: formData });
      const data = await res.json();

      if (!res.ok) {
        const detail = data.details
          ? '\n' + (Array.isArray(data.details) ? data.details.join('\n') : data.details)
          : '';
        setError(data.error + detail);
        return;
      }

      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsLoading(false);
    }
  };

  if (result) {
    return (
      <div className="bg-white rounded-lg shadow p-8 text-center">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-mt-dark mb-2">Upload Complete</h2>
        <p className="text-gray-600 mb-6">
          Created <strong>{result.requests_created}</strong> request(s) with{' '}
          <strong>{result.entities_created}</strong> total entities
          {(result.entity_transcripts_ordered || 0) > 0 && (
            <span className="block text-blue-600 mt-1">
              + {result.entity_transcripts_ordered} Entity Transcript{(result.entity_transcripts_ordered || 0) > 1 ? 's' : ''} ordered (${((result.entity_transcripts_ordered || 0) * ENTITY_TRANSCRIPT_PRICE).toFixed(2)})
            </span>
          )}
        </p>
        <div className="bg-gray-50 rounded-lg p-4 mb-6 text-left max-w-md mx-auto">
          <p className="text-sm font-semibold text-gray-700 mb-2">Loan Numbers:</p>
          <ul className="space-y-1">
            {result.loan_numbers.map((ln) => (
              <li key={ln} className="text-sm text-gray-600 font-mono">{ln}</li>
            ))}
          </ul>
        </div>
        <div className="flex gap-4 justify-center">
          <button onClick={() => router.push('/')} className="bg-mt-green text-white px-6 py-3 rounded-lg font-semibold hover:bg-opacity-90 transition-colors">
            View Dashboard
          </button>
          <button
            onClick={() => {
              setResult(null);
              setFile(null);
              setLoanNumber('');
              setNotes('');
              setPreviewEntities(null);
              if (fileRef.current) fileRef.current.value = '';
            }}
            className="px-6 py-3 border border-gray-300 rounded-lg font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
          >
            Upload Another
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-700 text-sm whitespace-pre-wrap">{error}</p>
        </div>
      )}

      <div className="bg-white rounded-lg shadow p-8">
        <h2 className="text-xl font-bold text-mt-dark mb-2">Upload CSV / Excel</h2>
        <p className="text-gray-500 text-sm mb-6">Enter the loan number and upload a spreadsheet with entity data.</p>

        <div className="mb-6">
          <label className="block text-sm font-semibold text-mt-dark mb-2">Loan Number <span className="text-red-500">*</span></label>
          <input
            type="text" value={loanNumber} onChange={(e) => setLoanNumber(e.target.value)}
            placeholder="e.g. 12345 or APP-2026-001" disabled={isLoading}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
          />
        </div>

        <div className="mb-6">
          <div className="flex items-center gap-3 mb-3">
            <button type="button" onClick={() => setShowColumnRef(!showColumnRef)}
              className="inline-flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors">
              <svg className={`w-4 h-4 transition-transform ${showColumnRef ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              Column Reference
            </button>
            <button type="button"
              onClick={() => {
                const headers = 'legal_name,tid,email,years,tid_kind,form,first name,last name,address,city,state,zip_code,signature_id';
                const example = '"Acme Holdings LLC","12-3456789","owner@acme.com","2023,2024,2025","EIN","1040","Jane","Doe","123 Main St","Houston","TX","77001",""';
                const csv = headers + '\n' + example + '\n';
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = 'moderntax-csv-template.csv'; a.click();
                URL.revokeObjectURL(url);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download Template
            </button>
          </div>

          {showColumnRef && (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-5 space-y-4 text-sm">
              <div>
                <p className="font-semibold text-gray-900 mb-2">Required Columns:</p>
                <ul className="space-y-1.5 text-gray-700">
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">legal_name</span> — Legal entity name (e.g., &quot;Acme Holdings LLC&quot;)</li>
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">tid</span> — Tax ID number (e.g., &quot;12-3456789&quot; for EIN, &quot;123-45-6789&quot; for SSN)</li>
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">email</span> — Signer email for 8821 delivery (e.g., &quot;owner@acme.com&quot;)</li>
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">years</span> — Tax years, comma-separated (e.g., &quot;2023,2024,2025&quot;)</li>
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">first name</span> — Signer first name for 8821 form</li>
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">last name</span> — Signer last name for 8821 form</li>
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">address</span>, <span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">city</span>, <span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">state</span>, <span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">zip_code</span> — Entity address for 8821 form</li>
                </ul>
              </div>
              <div>
                <p className="font-semibold text-gray-900 mb-2">Optional Columns:</p>
                <ul className="space-y-1.5 text-gray-700">
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">tid_kind</span> — &quot;EIN&quot; (default) or &quot;SSN&quot;</li>
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">form</span> — Tax form: 1040, 1065, 1120, or 1120S (default: 1040)</li>
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">signature_id</span> — Pre-signed Dropbox Sign ID (skips 8821 send)</li>
                </ul>
              </div>
            </div>
          )}
        </div>

        <label htmlFor="csv-file-input"
          className={`block border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
            file ? 'border-mt-green bg-green-50' : 'border-gray-300 hover:border-gray-400'
          }`}>
          <input id="csv-file-input" ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleFileChange} className="hidden" />
          {file ? (
            <div>
              <svg className="w-12 h-12 text-mt-green mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-mt-dark font-semibold">{file.name}</p>
              <p className="text-gray-500 text-sm mt-1">{(file.size / 1024).toFixed(1)} KB &middot; Click to change</p>
            </div>
          ) : (
            <div>
              <svg className="w-12 h-12 text-gray-400 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="text-gray-600 font-medium">Click to select a CSV or Excel file</p>
              <p className="text-gray-400 text-sm mt-1">Supports .csv, .xlsx, .xls</p>
            </div>
          )}
        </label>

        <div className="mt-6">
          <label className="block text-sm font-semibold text-mt-dark mb-2">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any additional context for this batch..." rows={3} disabled={isLoading}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
        </div>
      </div>

      {previewEntities && previewEntities.length > 0 && (
        <div className="bg-white rounded-lg shadow p-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-bold text-mt-dark">Review Entities</h3>
              <p className="text-sm text-gray-500">{previewEntities.length} entities found in file</p>
            </div>
            {einCount > 0 && (
              <button type="button" onClick={() => toggleAllEntityTranscripts(entityTranscriptCount < einCount)}
                className="text-xs font-medium text-blue-600 hover:text-blue-800 transition-colors">
                {entityTranscriptCount >= einCount ? 'Deselect All' : 'Select All EIN Entities'}
              </button>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Entity Name</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Tax ID</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Signer</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Address</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Form</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Years</th>
                  <th className="text-center py-2 px-3 text-xs font-semibold text-blue-600 uppercase whitespace-nowrap">
                    Entity Transcript
                    <span className="block text-blue-400 font-normal normal-case">${ENTITY_TRANSCRIPT_PRICE}/ea</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {previewEntities.map((entity) => (
                  <tr key={entity.rowIndex} className={`border-b border-gray-100 hover:bg-gray-50 ${entity.missingFields.length > 0 ? 'bg-red-50' : entity.isRepeat ? 'bg-emerald-50/40' : ''}`}>
                    <td className="py-2.5 px-3 font-medium text-mt-dark">
                      <div className="flex items-center gap-2">
                        <span>{entity.legalName || <span className="text-red-500 italic">missing</span>}</span>
                        {entity.isRepeat && (
                          <span title={`Existing 8821 on file from prior request for "${entity.repeatOfName}". Signer details will be auto-filled.`}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
                            ↻ Repeat borrower
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-gray-600 text-xs">
                      {entity.tid || <span className="text-red-500 italic">missing</span>}
                      <span className="text-gray-400 ml-1">({entity.tidKind})</span>
                    </td>
                    <td className="py-2.5 px-3 text-gray-600 text-xs">
                      {entity.firstName || entity.lastName ? (
                        <div>
                          <div>{entity.firstName} {entity.lastName}</div>
                          <div className="text-gray-400 truncate max-w-[160px]">{entity.email || <span className="text-red-500 italic">no email</span>}</div>
                        </div>
                      ) : entity.isRepeat ? (
                        <span className="text-emerald-700 italic text-[11px]">auto-filled from existing 8821</span>
                      ) : (
                        <span className="text-red-500 italic">missing name</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-gray-600 text-xs">
                      {entity.address ? (
                        <div className="max-w-[180px]">
                          <div className="truncate">{entity.address}</div>
                          <div className="text-gray-400">{entity.city}, {entity.state} {entity.zipCode}</div>
                        </div>
                      ) : entity.isRepeat ? (
                        <span className="text-emerald-700 italic text-[11px]">auto-filled</span>
                      ) : (
                        <span className="text-red-500 italic">missing</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-gray-600">{entity.formType}</td>
                    <td className="py-2.5 px-3 text-gray-600 text-xs">{entity.years || <span className="text-red-500 italic">missing</span>}</td>
                    <td className="py-2.5 px-3 text-center">
                      {entity.tidKind === 'EIN' ? (
                        <input type="checkbox" checked={entity.entityTranscript} onChange={() => toggleEntityTranscript(entity.rowIndex)}
                          className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                      ) : (
                        <span className="text-xs text-gray-400">N/A</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {previewEntities.some(e => e.missingFields.length > 0) && (
            <div className="mt-4 rounded-lg p-3 text-sm bg-red-50 border border-red-200">
              <div className="flex items-start gap-2">
                <span className="text-lg">⚠️</span>
                <div className="flex-1">
                  <p className="text-red-800 font-semibold mb-1">Missing required fields</p>
                  <p className="text-red-700 text-xs">
                    The following fields are required to generate 8821 forms:{' '}
                    <code className="bg-red-100 px-1 rounded">legal_name</code>,{' '}
                    <code className="bg-red-100 px-1 rounded">tid</code>,{' '}
                    <code className="bg-red-100 px-1 rounded">email</code>,{' '}
                    <code className="bg-red-100 px-1 rounded">first name</code>,{' '}
                    <code className="bg-red-100 px-1 rounded">last name</code>,{' '}
                    <code className="bg-red-100 px-1 rounded">address</code>,{' '}
                    <code className="bg-red-100 px-1 rounded">city</code>,{' '}
                    <code className="bg-red-100 px-1 rounded">state</code>,{' '}
                    <code className="bg-red-100 px-1 rounded">zip_code</code>,{' '}
                    <code className="bg-red-100 px-1 rounded">years</code>.
                    Please update your spreadsheet and re-upload.
                  </p>
                  <ul className="mt-2 space-y-0.5">
                    {previewEntities.filter(e => e.missingFields.length > 0).map(e => (
                      <li key={e.rowIndex} className="text-red-700 text-xs">
                        Row {e.rowIndex + 2} ({e.legalName || 'unnamed'}): missing <strong>{e.missingFields.join(', ')}</strong>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {einCount > 0 && (
            <div className={`mt-4 rounded-lg p-3 text-sm ${entityTranscriptCount > 0 ? 'bg-blue-50 border border-blue-200' : 'bg-gray-50 border border-gray-200'}`}>
              <div className="flex items-start gap-2">
                <span className="text-lg">{entityTranscriptCount > 0 ? '📋' : '💡'}</span>
                <div className="flex-1">
                  {entityTranscriptCount > 0 ? (
                    <p className="text-blue-800">
                      <strong>{entityTranscriptCount} Entity Transcript{entityTranscriptCount > 1 ? 's' : ''}</strong> selected — ${(entityTranscriptCount * ENTITY_TRANSCRIPT_PRICE).toFixed(2)} add-on.
                      Filing requirements will be confirmed before pulling income transcripts.
                    </p>
                  ) : (
                    <p className="text-gray-600">
                      <strong>Tip:</strong> Add an Entity Transcript ($19.99/ea) to confirm IRS filing requirements before pulling income transcripts.
                      This prevents blank results from requesting the wrong form type.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <button type="submit" disabled={isLoading || !file || hasValidationErrors}
        className="w-full bg-mt-green text-white py-4 rounded-lg font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-lg">
        {isLoading ? 'Processing...' : hasValidationErrors ? 'Fix Missing Fields to Continue' : (
          entityTranscriptCount > 0
            ? `Upload & Create Requests (+${entityTranscriptCount} Entity Transcript${entityTranscriptCount > 1 ? 's' : ''}: $${(entityTranscriptCount * ENTITY_TRANSCRIPT_PRICE).toFixed(2)})`
            : 'Upload & Create Requests'
        )}
      </button>
    </form>
  );
}
