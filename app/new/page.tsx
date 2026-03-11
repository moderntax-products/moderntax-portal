'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import Link from 'next/link';

type Tab = 'csv' | 'pdf' | 'manual';

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
  const [result, setResult] = useState<{
    requests_created: number;
    entities_created: number;
    loan_numbers: string[];
  } | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      setError(null);
      setResult(null);
    }
  };

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

      const res = await fetch('/api/upload/csv', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        const detail = data.details ? '\n' + data.details.join('\n') : '';
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
            placeholder="e.g. 12345 or APP-2024-001"
            disabled={isLoading}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
          />
        </div>

        {/* Expected columns */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
          <p className="text-sm font-semibold text-blue-800 mb-2">Expected Columns:</p>
          <p className="text-xs text-blue-700 font-mono leading-relaxed">
            legal_name, tid, tid_kind, address, city, state, zip_code, years, form
          </p>
          <p className="text-xs text-blue-600 mt-1">
            Optional: signature_id, first name, last name, signature_created_at
          </p>
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

      <button
        type="submit"
        disabled={isLoading || !file}
        className="w-full bg-mt-green text-white py-4 rounded-lg font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-lg"
      >
        {isLoading ? 'Processing...' : 'Upload & Create Requests'}
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
  const [years, setYears] = useState('2024');
  const [notes, setNotes] = useState('');
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
              placeholder="e.g., 2024, 2023, 2022"
              disabled={isLoading}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
            />
            <p className="text-xs text-gray-500 mt-1">Comma-separated years</p>
          </div>
        </div>

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
    { id: '1', entityName: '', tid: '', tidKind: 'EIN' as 'EIN' | 'SSN', formType: '1040', years: [] as string[] },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const TAX_YEARS = ['2024', '2023', '2022', '2021'];

  const addEntity = () => {
    setEntities([
      ...entities,
      { id: Math.random().toString(36).substr(2, 9), entityName: '', tid: '', tidKind: 'EIN', formType: '1040', years: [] },
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
        form_type: ent.formType,
        years: ent.years,
        status: 'pending',
      }));

      const { error: entError } = await supabase.from('request_entities').insert(entitiesData);
      if (entError) { setError('Failed to create entities'); return; }

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

      <button type="submit" disabled={isLoading}
        className="w-full bg-mt-green text-white py-4 rounded-lg font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-lg">
        {isLoading ? 'Submitting...' : 'Submit Request'}
      </button>
    </form>
  );
}
