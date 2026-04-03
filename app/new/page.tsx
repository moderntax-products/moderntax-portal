'use client';

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import Link from 'next/link';
import * as XLSX from 'xlsx';

type Tab = 'csv' | 'pdf' | 'manual';

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
}

export default function NewRequestPage() {
  const [activeTab, setActiveTab] = useState<Tab>('csv');

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-mt-dark">New Request</h1>
            <p className="text-gray-600 mt-1">Submit verification requests via CSV upload, PDF upload, or manual entry</p>
          </div>
          <Link href="/" className="text-gray-600 hover:text-gray-900 font-medium">
            &larr; Back to Dashboard
          </Link>
        </div>
      </div>

      {/* Tabs */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-8">
        <div className="flex border-b border-gray-200">
          {[
            { key: 'csv' as Tab, label: 'CSV / Excel Upload', icon: '📊' },
            { key: 'pdf' as Tab, label: 'Signed 8821 PDF', icon: '📄' },
            { key: 'manual' as Tab, label: 'Manual Entry', icon: '✏️' },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-6 py-3 text-sm font-semibold border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-mt-green text-mt-green'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <span className="mr-2">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'csv' && <CsvUploadTab />}
        {activeTab === 'pdf' && <PdfUploadTab />}
        {activeTab === 'manual' && <ManualEntryTab />}
      </div>
    </div>
  );
}

// ============================================================
// CSV Upload Tab
// ============================================================
function CsvUploadTab() {
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

  // Normalize header helper
  const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/\s+/g, '_');

  // Parse CSV/Excel client-side for preview
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

        // Track missing required fields
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
    } catch {
      // If parse fails, let the server handle it — clear preview
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
    if (!file) {
      setError('Please select a file');
      return;
    }
    if (!loanNumber.trim()) {
      setError('Loan number is required');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('loan_number', loanNumber.trim());
      if (notes) formData.append('notes', notes);

      // Pass entity transcript selections as JSON array of row indices
      if (previewEntities) {
        const selectedIndices = previewEntities
          .filter(e => e.entityTranscript)
          .map(e => e.rowIndex);
        if (selectedIndices.length > 0) {
          formData.append('entity_transcript_indices', JSON.stringify(selectedIndices));
        }
      }

      const res = await fetch('/api/upload/csv', {
        method: 'POST',
        body: formData,
      });

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
              <li key={ln} className="text-sm text-gray-600 font-mono">
                {ln}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex gap-4 justify-center">
          <button
            onClick={() => router.push('/')}
            className="bg-mt-green text-white px-6 py-3 rounded-lg font-semibold hover:bg-opacity-90 transition-colors"
          >
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
        <p className="text-gray-500 text-sm mb-6">
          Enter the loan number and upload a spreadsheet with entity data.
        </p>

        {/* Loan Number */}
        <div className="mb-6">
          <label className="block text-sm font-semibold text-mt-dark mb-2">
            Loan Number <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={loanNumber}
            onChange={(e) => setLoanNumber(e.target.value)}
            placeholder="e.g. 12345 or APP-2026-001"
            disabled={isLoading}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
          />
        </div>

        {/* Column Reference & Template */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-3">
            <button
              type="button"
              onClick={() => setShowColumnRef(!showColumnRef)}
              className="inline-flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors"
            >
              <svg
                className={`w-4 h-4 transition-transform ${showColumnRef ? 'rotate-90' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              Column Reference
            </button>
            <button
              type="button"
              onClick={() => {
                const headers = 'legal_name,tid,email,years,tid_kind,form,first name,last name,address,city,state,zip_code,signature_id';
                const example = '"Acme Holdings LLC","12-3456789","owner@acme.com","2023,2024,2025","EIN","1040","Jane","Doe","123 Main St","Houston","TX","77001",""';
                const csv = headers + '\n' + example + '\n';
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'moderntax-csv-template.csv';
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
            >
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

        {/* File input */}
        <label
          htmlFor="csv-file-input"
          className={`block border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
            file ? 'border-mt-green bg-green-50' : 'border-gray-300 hover:border-gray-400'
          }`}
        >
          <input
            id="csv-file-input"
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={handleFileChange}
            className="hidden"
          />
          {file ? (
            <div>
              <svg className="w-12 h-12 text-mt-green mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-mt-dark font-semibold">{file.name}</p>
              <p className="text-gray-500 text-sm mt-1">
                {(file.size / 1024).toFixed(1)} KB &middot; Click to change
              </p>
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

        {/* Notes */}
        <div className="mt-6">
          <label className="block text-sm font-semibold text-mt-dark mb-2">
            Notes <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any additional context for this batch..."
            rows={3}
            disabled={isLoading}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
          />
        </div>
      </div>

      {/* Entity Preview & Entity Transcript Selection */}
      {previewEntities && previewEntities.length > 0 && (
        <div className="bg-white rounded-lg shadow p-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-bold text-mt-dark">Review Entities</h3>
              <p className="text-sm text-gray-500">{previewEntities.length} entities found in file</p>
            </div>
            {einCount > 0 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => toggleAllEntityTranscripts(entityTranscriptCount < einCount)}
                  className="text-xs font-medium text-blue-600 hover:text-blue-800 transition-colors"
                >
                  {entityTranscriptCount >= einCount ? 'Deselect All' : 'Select All EIN Entities'}
                </button>
              </div>
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
                  <tr key={entity.rowIndex} className={`border-b border-gray-100 hover:bg-gray-50 ${entity.missingFields.length > 0 ? 'bg-red-50' : ''}`}>
                    <td className="py-2.5 px-3 font-medium text-mt-dark">
                      {entity.legalName || <span className="text-red-500 italic">missing</span>}
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
                      ) : (
                        <span className="text-red-500 italic">missing</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-gray-600">{entity.formType}</td>
                    <td className="py-2.5 px-3 text-gray-600 text-xs">{entity.years || <span className="text-red-500 italic">missing</span>}</td>
                    <td className="py-2.5 px-3 text-center">
                      {entity.tidKind === 'EIN' ? (
                        <input
                          type="checkbox"
                          checked={entity.entityTranscript}
                          onChange={() => toggleEntityTranscript(entity.rowIndex)}
                          className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                      ) : (
                        <span className="text-xs text-gray-400">N/A</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Validation warnings */}
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

          {/* Entity Transcript info banner */}
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

      <button
        type="submit"
        disabled={isLoading || !file || hasValidationErrors}
        className="w-full bg-mt-green text-white py-4 rounded-lg font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-lg"
      >
        {isLoading ? 'Processing...' : hasValidationErrors ? 'Fix Missing Fields to Continue' : (
          entityTranscriptCount > 0
            ? `Upload & Create Requests (+${entityTranscriptCount} Entity Transcript${entityTranscriptCount > 1 ? 's' : ''}: $${(entityTranscriptCount * ENTITY_TRANSCRIPT_PRICE).toFixed(2)})`
            : 'Upload & Create Requests'
        )}
      </button>
    </form>
  );
}

// ============================================================
// PDF Upload Tab
// ============================================================
function PdfUploadTab() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [loanNumber, setLoanNumber] = useState('');
  const [entityName, setEntityName] = useState('');
  const [tid, setTid] = useState('');
  const [tidKind, setTidKind] = useState<'EIN' | 'SSN'>('EIN');
  const [formType, setFormType] = useState('1040');
  const [years, setYears] = useState(String(new Date().getFullYear()));
  const [notes, setNotes] = useState('');
  const [entityTranscript, setEntityTranscript] = useState(false);
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

    if (files.length === 0) {
      setError('Please select at least one PDF file');
      return;
    }
    if (!loanNumber.trim()) {
      setError('Loan number is required');
      return;
    }
    if (!entityName.trim()) {
      setError('Entity name is required');
      return;
    }
    if (!tid.trim()) {
      setError('Tax ID is required');
      return;
    }

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
      if (entityTranscript) formData.append('entity_transcript', 'true');
      if (notes) formData.append('notes', notes);

      const res = await fetch('/api/upload/pdf', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Upload failed');
        return;
      }

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
          <button
            onClick={() => router.push(`/request/${requestId}`)}
            className="bg-mt-green text-white px-6 py-3 rounded-lg font-semibold hover:bg-opacity-90 transition-colors"
          >
            View Request
          </button>
          <button
            onClick={() => router.push('/')}
            className="px-6 py-3 border border-gray-300 rounded-lg font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
          >
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
        <p className="text-gray-500 text-sm mb-6">
          Upload a pre-signed IRS Form 8821 (Tax Information Authorization) PDF.
        </p>

        {/* Entity Info */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <div>
            <label className="block text-sm font-semibold text-mt-dark mb-2">
              Loan / Application Number <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={loanNumber}
              onChange={(e) => setLoanNumber(e.target.value)}
              placeholder="e.g., 12345"
              disabled={isLoading}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-mt-dark mb-2">
              Entity / Legal Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={entityName}
              onChange={(e) => setEntityName(e.target.value)}
              placeholder="Business or individual name"
              disabled={isLoading}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-mt-dark mb-2">
              Tax ID <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-3">
              <select
                value={tidKind}
                onChange={(e) => setTidKind(e.target.value as 'EIN' | 'SSN')}
                disabled={isLoading}
                className="px-3 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
              >
                <option value="EIN">EIN</option>
                <option value="SSN">SSN</option>
              </select>
              <input
                type="text"
                value={tid}
                onChange={(e) => setTid(e.target.value)}
                placeholder={tidKind === 'EIN' ? 'XX-XXXXXXX' : 'XXX-XX-XXXX'}
                disabled={isLoading}
                className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 font-mono"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold text-mt-dark mb-2">Form Type</label>
            <select
              value={formType}
              onChange={(e) => setFormType(e.target.value)}
              disabled={isLoading}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
            >
              <option value="1040">1040 (Individual)</option>
              <option value="1065">1065 (Partnership)</option>
              <option value="1120">1120 (Corporation)</option>
              <option value="1120S">1120S (S-Corp)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold text-mt-dark mb-2">Tax Years</label>
            <input
              type="text"
              value={years}
              onChange={(e) => setYears(e.target.value)}
              placeholder={`e.g., ${new Date().getFullYear()}, ${new Date().getFullYear() - 1}, ${new Date().getFullYear() - 2}`}
              disabled={isLoading}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
            />
            <p className="text-xs text-gray-500 mt-1">Comma-separated years</p>
          </div>
        </div>

        {/* Entity Transcript Add-on */}
        {tidKind === 'EIN' && (
          <div className={`mb-6 border rounded-lg p-4 transition-colors ${entityTranscript ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-gray-50'}`}>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={entityTranscript}
                onChange={() => setEntityTranscript(!entityTranscript)}
                disabled={isLoading}
                className="w-5 h-5 mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
              />
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-mt-dark text-sm">Add Entity Transcript</span>
                  <span className="text-blue-600 font-bold text-sm">${ENTITY_TRANSCRIPT_PRICE.toFixed(2)}</span>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Confirms IRS filing requirements before pulling income transcripts. Prevents blank results from requesting the wrong form type.
                </p>
              </div>
            </label>
          </div>
        )}

        {/* File input */}
        <div
          className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
            files.length > 0 ? 'border-mt-green bg-green-50' : 'border-gray-300 hover:border-gray-400'
          }`}
          onClick={() => fileRef.current?.click()}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".pdf"
            multiple
            onChange={handleFileChange}
            className="hidden"
          />
          {files.length > 0 ? (
            <div>
              <svg className="w-12 h-12 text-mt-green mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-mt-dark font-semibold">
                {files.length} PDF{files.length > 1 ? 's' : ''} selected
              </p>
              <ul className="text-gray-500 text-sm mt-1">
                {files.map((f) => (
                  <li key={f.name}>
                    {f.name} ({(f.size / 1024).toFixed(1)} KB)
                  </li>
                ))}
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

        {/* Notes */}
        <div className="mt-6">
          <label className="block text-sm font-semibold text-mt-dark mb-2">
            Notes <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any additional context..."
            rows={3}
            disabled={isLoading}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={isLoading || files.length === 0}
        className="w-full bg-mt-green text-white py-4 rounded-lg font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-lg"
      >
        {isLoading ? 'Uploading...' : 'Upload Signed 8821'}
      </button>
    </form>
  );
}

// ============================================================
// Manual Entry Tab (kept from original, updated for new schema)
// ============================================================
function ManualEntryTab() {
  const router = useRouter();
  const supabase = createClient();

  const [loanNumber, setLoanNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [entities, setEntities] = useState([
    { id: '1', entityName: '', tid: '', tidKind: 'EIN' as 'EIN' | 'SSN', formType: '1040', years: [] as string[], signerEmail: '', address: '', city: '', state: '', zipCode: '', entityTranscript: false },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentYear = new Date().getFullYear();
  const TAX_YEARS = Array.from({ length: 6 }, (_, i) => String(currentYear - i));

  const addEntity = () => {
    setEntities([
      ...entities,
      { id: Math.random().toString(36).substr(2, 9), entityName: '', tid: '', tidKind: 'EIN', formType: '1040', years: [], signerEmail: '', address: '', city: '', state: '', zipCode: '', entityTranscript: false },
    ]);
  };

  const removeEntity = (id: string) => {
    if (entities.length > 1) setEntities(entities.filter((e) => e.id !== id));
  };

  const updateEntity = (id: string, updates: Partial<(typeof entities)[0]>) => {
    setEntities(entities.map((e) => (e.id === id ? { ...e, ...updates } : e)));
  };

  const toggleYear = (id: string, year: string) => {
    setEntities(
      entities.map((e) => {
        if (e.id !== id) return e;
        const newYears = e.years.includes(year) ? e.years.filter((y) => y !== year) : [...e.years, year];
        return { ...e, years: newYears };
      })
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!loanNumber.trim()) { setError('Loan number is required'); return; }
    for (const ent of entities) {
      if (!ent.entityName.trim()) { setError('All entities need a name'); return; }
      if (!ent.tid.trim()) { setError('All entities need a Tax ID'); return; }
      if (!ent.address.trim()) { setError('All entities need an address for the 8821 form'); return; }
      if (!ent.city.trim()) { setError('All entities need a city'); return; }
      if (!ent.state.trim()) { setError('All entities need a state'); return; }
      if (!ent.zipCode.trim()) { setError('All entities need a ZIP code'); return; }
      if (!ent.signerEmail.trim()) { setError('All entities need a signer email for 8821 delivery'); return; }
      if (ent.years.length === 0) { setError('Select at least one tax year per entity'); return; }
    }

    setIsLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setError('Not authenticated'); return; }

      const { data: profile } = await supabase
        .from('profiles')
        .select('client_id')
        .eq('id', user.id)
        .single() as { data: { client_id: string | null } | null; error: unknown };

      if (!profile?.client_id) { setError('No client associated'); return; }

      const { data: req, error: reqError } = await supabase
        .from('requests')
        .insert({
          client_id: profile.client_id,
          requested_by: user.id,
          loan_number: loanNumber.trim(),
          intake_method: 'manual',
          status: 'submitted',
          notes: notes || null,
        })
        .select()
        .single() as { data: { id: string } | null; error: unknown };

      if (reqError || !req) { setError('Failed to create request'); return; }

      const entitiesData = entities.map((ent) => ({
        request_id: req.id,
        entity_name: ent.entityName,
        tid: ent.tid,
        tid_kind: ent.tidKind,
        address: ent.address || null,
        city: ent.city || null,
        state: ent.state || null,
        zip_code: ent.zipCode || null,
        form_type: ent.formType,
        years: ent.years,
        signer_email: ent.signerEmail || null,
        status: 'pending',
        gross_receipts: ent.entityTranscript ? {
          entity_transcript_order: {
            requested: true,
            price: ENTITY_TRANSCRIPT_PRICE,
            ordered_at: new Date().toISOString(),
          },
        } : null,
      }));

      const { error: entError } = await supabase.from('request_entities').insert(entitiesData);
      if (entError) { setError('Failed to create entities'); return; }

      // Notify manager(s) if any entity transcript add-ons were ordered
      const etCount = entities.filter(ent => ent.entityTranscript).length;
      if (etCount > 0) {
        try {
          await fetch('/api/notify/entity-transcript', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              request_id: req.id,
              loan_number: loanNumber.trim(),
              entity_count: etCount,
            }),
          });
        } catch (notifyErr) {
          console.error('Failed to send manager notification:', notifyErr);
        }
      }

      router.push(`/request/${req.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-700 text-sm">{error}</p>
        </div>
      )}

      <div className="bg-white rounded-lg shadow p-8">
        <h2 className="text-xl font-bold text-mt-dark mb-6">Request Info</h2>
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-semibold text-mt-dark mb-2">
              Loan / Application Number <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={loanNumber}
              onChange={(e) => setLoanNumber(e.target.value)}
              placeholder="e.g., 12345"
              disabled={isLoading}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-mt-dark mb-2">
              Notes <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any additional info..."
              rows={3}
              disabled={isLoading}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
            />
          </div>
        </div>
      </div>

      {/* Entities */}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold text-mt-dark">Entities</h2>
          <p className="text-sm text-gray-600">{entities.length} entity/entities</p>
        </div>

        {entities.map((entity, index) => (
          <div key={entity.id} className="bg-white rounded-lg shadow p-8">
            <div className="flex justify-between items-start mb-6">
              <h3 className="text-lg font-semibold text-mt-dark">Entity {index + 1}</h3>
              {entities.length > 1 && (
                <button type="button" onClick={() => removeEntity(entity.id)} disabled={isLoading}
                  className="text-red-600 hover:text-red-700 font-medium text-sm disabled:opacity-50">
                  Remove
                </button>
              )}
            </div>

            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-semibold text-mt-dark mb-2">Entity Name <span className="text-red-500">*</span></label>
                  <input type="text" value={entity.entityName}
                    onChange={(e) => updateEntity(entity.id, { entityName: e.target.value })}
                    placeholder="Business or individual name" disabled={isLoading}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-mt-dark mb-2">Tax ID <span className="text-red-500">*</span></label>
                  <div className="flex gap-3">
                    <select value={entity.tidKind}
                      onChange={(e) => updateEntity(entity.id, { tidKind: e.target.value as 'EIN' | 'SSN' })}
                      disabled={isLoading}
                      className="px-3 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50">
                      <option value="EIN">EIN</option>
                      <option value="SSN">SSN</option>
                    </select>
                    <input type="text" value={entity.tid}
                      onChange={(e) => updateEntity(entity.id, { tid: e.target.value })}
                      placeholder={entity.tidKind === 'EIN' ? 'XX-XXXXXXX' : 'XXX-XX-XXXX'}
                      disabled={isLoading}
                      className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 font-mono"
                    />
                  </div>
                </div>
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-semibold text-mt-dark mb-2">Address <span className="text-red-500">*</span></label>
                <input type="text" value={entity.address || ''}
                  onChange={(e) => updateEntity(entity.id, { address: e.target.value })}
                  placeholder="Street address" disabled={isLoading}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
                />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-mt-dark mb-2">City <span className="text-red-500">*</span></label>
                  <input type="text" value={entity.city || ''}
                    onChange={(e) => updateEntity(entity.id, { city: e.target.value })}
                    placeholder="City" disabled={isLoading}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-mt-dark mb-2">State <span className="text-red-500">*</span></label>
                  <input type="text" value={entity.state || ''}
                    onChange={(e) => updateEntity(entity.id, { state: e.target.value })}
                    placeholder="TX" maxLength={2} disabled={isLoading}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-mt-dark mb-2">ZIP <span className="text-red-500">*</span></label>
                  <input type="text" value={entity.zipCode || ''}
                    onChange={(e) => updateEntity(entity.id, { zipCode: e.target.value })}
                    placeholder="77489" maxLength={10} disabled={isLoading}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-semibold text-mt-dark mb-2">Signer Email <span className="text-red-500">*</span></label>
                <input type="email" value={entity.signerEmail}
                  onChange={(e) => updateEntity(entity.id, { signerEmail: e.target.value })}
                  placeholder="signer@email.com" disabled={isLoading}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
                />
                <p className="text-xs text-gray-400 mt-1">Email address of the person who will sign the 8821 form</p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-mt-dark mb-2">Form Type</label>
                <select value={entity.formType}
                  onChange={(e) => updateEntity(entity.id, { formType: e.target.value })}
                  disabled={isLoading}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50">
                  <option value="1040">1040 (Individual)</option>
                  <option value="1065">1065 (Partnership)</option>
                  <option value="1120">1120 (Corporation)</option>
                  <option value="1120S">1120S (S-Corp)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold text-mt-dark mb-3">Tax Years <span className="text-red-500">*</span></label>
                <div className="flex flex-wrap gap-3">
                  {TAX_YEARS.map((year) => (
                    <label key={year} className="flex items-center gap-2">
                      <input type="checkbox" checked={entity.years.includes(year)}
                        onChange={() => toggleYear(entity.id, year)} disabled={isLoading}
                        className="w-4 h-4 rounded border-gray-300 text-mt-green focus:ring-mt-green disabled:opacity-50"
                      />
                      <span className="text-gray-700">{year}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Entity Transcript Add-on */}
              {entity.tidKind === 'EIN' && (
                <div className={`border rounded-lg p-4 transition-colors ${entity.entityTranscript ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-gray-50'}`}>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={entity.entityTranscript}
                      onChange={() => updateEntity(entity.id, { entityTranscript: !entity.entityTranscript })}
                      disabled={isLoading}
                      className="w-5 h-5 mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                    />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-mt-dark text-sm">Add Entity Transcript</span>
                        <span className="text-blue-600 font-bold text-sm">${ENTITY_TRANSCRIPT_PRICE.toFixed(2)}</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-1">
                        Confirms IRS filing requirements before pulling income transcripts. Prevents blank results from requesting the wrong form type (e.g., ordering 1065 when entity files 1120).
                      </p>
                    </div>
                  </label>
                </div>
              )}
            </div>
          </div>
        ))}

        <button type="button" onClick={addEntity} disabled={isLoading}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50 font-medium">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Another Entity
        </button>
      </div>

      {/* Order Summary */}
      {entities.some(e => e.entityTranscript) && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-sm font-semibold text-mt-dark mb-3">Order Summary</h3>
          <div className="space-y-2 text-sm">
            {entities.filter(e => e.entityTranscript).map((e, i) => (
              <div key={e.id} className="flex justify-between text-gray-600">
                <span>Entity Transcript — {e.entityName || `Entity ${i + 1}`}</span>
                <span className="font-medium">${ENTITY_TRANSCRIPT_PRICE.toFixed(2)}</span>
              </div>
            ))}
            <div className="border-t pt-2 mt-2 flex justify-between font-bold text-mt-dark">
              <span>Entity Transcript Add-ons</span>
              <span>${(entities.filter(e => e.entityTranscript).length * ENTITY_TRANSCRIPT_PRICE).toFixed(2)}</span>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">Standard transcript verification fees apply separately per entity.</p>
        </div>
      )}

      <button type="submit" disabled={isLoading}
        className="w-full bg-mt-green text-white py-4 rounded-lg font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-lg">
        {isLoading ? 'Submitting...' : 'Submit Request'}
      </button>
    </form>
  );
}
