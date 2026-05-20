'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import Link from 'next/link';

interface UserOption {
  id: string;
  email: string;
  full_name: string;
  role: string;
  client_name: string;
  client_id: string;
}

interface IntakeResult {
  success: boolean;
  request_id: string;
  batch_id: string;
  entities_created: number;
  loan_number: string;
  on_behalf_of: {
    email: string;
    name: string;
    role: string;
    client: string;
  };
  message: string;
}

export default function EmailIntakePage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Mode toggle: 'csv' (batch) or 'manual' (single entity + PDF 8821)
  const [mode, setMode] = useState<'csv' | 'manual'>('manual');

  // Form fields
  const [users, setUsers] = useState<UserOption[]>([]);
  const [selectedEmail, setSelectedEmail] = useState('');
  const [loanNumber, setLoanNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);

  // Manual mode fields
  const [entityName, setEntityName] = useState('');
  const [tid, setTid] = useState('');
  const [tidKind, setTidKind] = useState<'EIN' | 'SSN'>('EIN');
  const [formType, setFormType] = useState('1120');
  const [years, setYears] = useState('');

  // Result / error
  const [result, setResult] = useState<IntakeResult | null>(null);
  const [error, setError] = useState('');

  // Recent intakes for the log
  const [recentIntakes, setRecentIntakes] = useState<any[]>([]);

  useEffect(() => {
    async function init() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push('/login');
        return;
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();

      if (!profile || profile.role !== 'admin') {
        router.push('/');
        return;
      }

      setIsAdmin(true);

      // Fetch all client users (managers + processors)
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, email, full_name, role, client_id, clients(name)')
        .in('role', ['manager', 'processor'])
        .not('client_id', 'is', null)
        .order('full_name', { ascending: true });

      if (profiles) {
        const opts: UserOption[] = profiles.map((p: any) => ({
          id: p.id,
          email: p.email,
          full_name: p.full_name || p.email,
          role: p.role,
          client_name: p.clients?.name || 'Unknown',
          client_id: p.client_id,
        }));
        setUsers(opts);
      }

      // Fetch recent email-intake requests
      const { data: recent } = await supabase
        .from('requests')
        .select('id, loan_number, created_at, notes, status, profiles!requested_by(full_name, email), clients(name)')
        .like('notes', '%email intake%')
        .order('created_at', { ascending: false })
        .limit(10);

      if (recent) {
        setRecentIntakes(recent);
      }

      setLoading(false);
    }
    init();
  }, [router]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      if (mode === 'manual') {
        if (!f.name.toLowerCase().endsWith('.pdf')) {
          setError('Please upload a PDF file (signed 8821)');
          return;
        }
      } else {
        const validTypes = [
          'text/csv',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ];
        const validExtensions = ['.csv', '.xlsx', '.xls'];
        const ext = f.name.substring(f.name.lastIndexOf('.')).toLowerCase();

        if (!validTypes.includes(f.type) && !validExtensions.includes(ext)) {
          setError('Please upload a CSV or Excel file');
          return;
        }
      }
      setFile(f);
      setError('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResult(null);

    if (!selectedEmail) {
      setError('Please select a user');
      return;
    }
    if (!loanNumber.trim()) {
      setError('Loan number is required');
      return;
    }
    if (mode === 'csv' && !file) {
      setError('Please upload a CSV or Excel file');
      return;
    }
    if (mode === 'manual') {
      if (!entityName.trim()) { setError('Entity name is required'); return; }
      if (!tid.trim()) { setError('EIN/SSN is required'); return; }
      if (!years.trim()) { setError('Tax year(s) required'); return; }
    }

    setSubmitting(true);

    try {
      const formData = new FormData();
      formData.append('mode', mode);
      formData.append('sender_email', selectedEmail);
      formData.append('loan_number', loanNumber.trim());
      if (notes.trim()) {
        formData.append('notes', notes.trim());
      }
      if (file) {
        formData.append('file', file);
      }
      if (mode === 'manual') {
        formData.append('entity_name', entityName.trim());
        formData.append('tid', tid.trim());
        formData.append('tid_kind', tidKind);
        formData.append('form_type', formType);
        formData.append('years', years.trim());
      }

      const res = await fetch('/api/admin/email-intake', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Failed to process intake');
        return;
      }

      setResult(data);

      // Reset form
      setSelectedEmail('');
      setLoanNumber('');
      setNotes('');
      setFile(null);
      setEntityName('');
      setTid('');
      setTidKind('EIN');
      setFormType('1120');
      setYears('');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      // Add to recent intakes
      setRecentIntakes((prev) => [
        {
          id: data.request_id,
          loan_number: data.loan_number,
          created_at: new Date().toISOString(),
          notes: notes ? `[Via email intake by admin] ${notes}` : '[Submitted via email intake]',
          status: 'submitted',
          profiles: { full_name: data.on_behalf_of.name, email: data.on_behalf_of.email },
          clients: { name: data.on_behalf_of.client },
        },
        ...prev,
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  // Group users by client for the dropdown
  const usersByClient: Record<string, UserOption[]> = {};
  users.forEach((u) => {
    if (!usersByClient[u.client_name]) {
      usersByClient[u.client_name] = [];
    }
    usersByClient[u.client_name].push(u);
  });

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#00C48C]" />
      </div>
    );
  }

  if (!isAdmin) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* SOC 2 Banner */}
      <div className="border-b px-4 py-2 text-center text-xs font-semibold tracking-wide bg-blue-50 text-blue-800 border-blue-200">
        INTERNAL USE ONLY - CONFIDENTIAL
      </div>

      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-[#0A1929]">Email Intake</h1>
            <p className="text-gray-600 mt-1">
              Process emailed CSVs on behalf of client users
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/admin"
              className="px-4 py-2 text-sm font-medium text-[#0A1929] border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Admin Dashboard
            </Link>
            <Link
              href="/admin/team"
              className="px-4 py-2 text-sm font-medium text-[#0A1929] border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Team
            </Link>
            <Link
              href="/"
              className="text-gray-600 hover:text-gray-900 font-medium text-sm"
            >
              Dashboard
            </Link>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Form */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 bg-[#00C48C]/10 rounded-lg flex items-center justify-center">
                  <svg className="w-5 h-5 text-[#00C48C]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-[#0A1929]">Process Email Order</h2>
                  <p className="text-sm text-gray-500">Upload a CSV received via email and attribute it to the sender</p>
                </div>
              </div>

              <form onSubmit={handleSubmit} className="space-y-5">
                {/* Mode toggle */}
                <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => { setMode('manual'); setFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                    className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${
                      mode === 'manual'
                        ? 'bg-[#0A1929] text-white'
                        : 'bg-white text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    Manual Entry + 8821 PDF
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMode('csv'); setFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                    className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${
                      mode === 'csv'
                        ? 'bg-[#0A1929] text-white'
                        : 'bg-white text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    CSV Batch Upload
                  </button>
                </div>

                {/* User select */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    On Behalf Of <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={selectedEmail}
                    onChange={(e) => setSelectedEmail(e.target.value)}
                    className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#00C48C] focus:border-[#00C48C] outline-none"
                  >
                    <option value="">Select user who sent the email...</option>
                    {Object.entries(usersByClient)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([clientName, clientUsers]) => (
                        <optgroup key={clientName} label={clientName}>
                          {clientUsers.map((u) => (
                            <option key={u.id} value={u.email}>
                              {u.full_name} ({u.email}) - {u.role}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                  </select>
                </div>

                {/* Loan number */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Loan / Application Number <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={loanNumber}
                    onChange={(e) => setLoanNumber(e.target.value)}
                    placeholder="e.g. LN-2026-0042"
                    className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#00C48C] focus:border-[#00C48C] outline-none"
                  />
                </div>

                {/* Manual entry fields */}
                {mode === 'manual' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">
                        Entity / Business Name <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={entityName}
                        onChange={(e) => setEntityName(e.target.value)}
                        placeholder="e.g. K.O.K. Trucking LLC"
                        className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#00C48C] focus:border-[#00C48C] outline-none"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1.5">
                          EIN / SSN <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="text"
                          value={tid}
                          onChange={(e) => setTid(e.target.value)}
                          placeholder="XX-XXXXXXX"
                          className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#00C48C] focus:border-[#00C48C] outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1.5">
                          TID Type
                        </label>
                        <select
                          value={tidKind}
                          onChange={(e) => setTidKind(e.target.value as 'EIN' | 'SSN')}
                          className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#00C48C] focus:border-[#00C48C] outline-none"
                        >
                          <option value="EIN">EIN</option>
                          <option value="SSN">SSN</option>
                        </select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1.5">
                          Form Type <span className="text-red-500">*</span>
                        </label>
                        <select
                          value={formType}
                          onChange={(e) => setFormType(e.target.value)}
                          className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#00C48C] focus:border-[#00C48C] outline-none"
                        >
                          <option value="1040">1040 (Individual)</option>
                          <option value="1065">1065 (Partnership)</option>
                          <option value="1120">1120 (C-Corp)</option>
                          <option value="1120S">1120S (S-Corp)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1.5">
                          Tax Year(s) <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="text"
                          value={years}
                          onChange={(e) => setYears(e.target.value)}
                          placeholder="e.g. 2024 or 2023, 2024"
                          className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#00C48C] focus:border-[#00C48C] outline-none"
                        />
                      </div>
                    </div>
                  </>
                )}

                {/* File upload */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    {mode === 'manual' ? (
                      <>Signed 8821 PDF <span className="text-gray-400">(optional — upload later)</span></>
                    ) : (
                      <>CSV / Excel File <span className="text-red-500">*</span></>
                    )}
                  </label>
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                      file
                        ? 'border-[#00C48C] bg-[#00C48C]/5'
                        : 'border-gray-300 hover:border-gray-400 bg-gray-50'
                    }`}
                  >
                    {file ? (
                      <div className="flex items-center justify-center gap-2">
                        <svg className="w-5 h-5 text-[#00C48C]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span className="text-sm font-medium text-[#0A1929]">{file.name}</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setFile(null);
                            if (fileInputRef.current) fileInputRef.current.value = '';
                          }}
                          className="ml-2 text-gray-400 hover:text-red-500"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ) : (
                      <div>
                        <svg className="mx-auto w-8 h-8 text-gray-400 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                        </svg>
                        <p className="text-sm text-gray-600">
                          {mode === 'manual'
                            ? 'Click to upload signed 8821 PDF'
                            : 'Click to upload CSV or Excel file'}
                        </p>
                        <p className="text-xs text-gray-400 mt-1">
                          {mode === 'manual' ? '.pdf' : '.csv, .xlsx, .xls'}
                        </p>
                      </div>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={mode === 'manual' ? '.pdf' : '.csv,.xlsx,.xls'}
                      onChange={handleFileChange}
                      className="hidden"
                    />
                  </div>
                </div>

                {/* Notes */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Notes <span className="text-gray-400">(optional)</span>
                  </label>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="e.g. Received via email on 3/12, rush order"
                    rows={3}
                    className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#00C48C] focus:border-[#00C48C] outline-none resize-none"
                  />
                </div>

                {/* Error */}
                {error && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                    {error}
                  </div>
                )}

                {/* Success */}
                {result && (
                  <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span className="font-semibold text-green-800">Request Created</span>
                    </div>
                    <div className="text-sm text-green-700 space-y-1">
                      <p>{result.message}</p>
                      <p className="text-xs text-green-600">
                        {result.entities_created} entities &middot; Loan #{result.loan_number}
                      </p>
                    </div>
                    <Link
                      href={`/admin/requests/${result.request_id}`}
                      className="inline-block mt-3 px-4 py-2 bg-[#00C48C] text-white text-sm font-medium rounded-lg hover:bg-[#00C48C]/90 transition-colors"
                    >
                      View Request &rarr;
                    </Link>
                  </div>
                )}

                {/* Submit */}
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full py-3 px-4 bg-[#0A1929] text-white font-semibold rounded-lg hover:bg-[#102A43] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {submitting ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                      Submit on Behalf of User
                    </>
                  )}
                </button>
              </form>
            </div>
          </div>

          {/* Sidebar: Info + Recent */}
          <div className="space-y-6">
            {/* How it works */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-[#0A1929] mb-3">How It Works</h3>
              {mode === 'manual' ? (
                <ol className="text-sm text-gray-600 space-y-2.5">
                  <li className="flex gap-2">
                    <span className="flex-shrink-0 w-5 h-5 bg-[#00C48C]/10 text-[#00C48C] rounded-full flex items-center justify-center text-xs font-bold">1</span>
                    <span>User emails an 8821 PDF to matt@moderntax.io</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="flex-shrink-0 w-5 h-5 bg-[#00C48C]/10 text-[#00C48C] rounded-full flex items-center justify-center text-xs font-bold">2</span>
                    <span>Select the sender and enter entity details</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="flex-shrink-0 w-5 h-5 bg-[#00C48C]/10 text-[#00C48C] rounded-full flex items-center justify-center text-xs font-bold">3</span>
                    <span>Upload the signed 8821 PDF (or add later)</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="flex-shrink-0 w-5 h-5 bg-[#00C48C]/10 text-[#00C48C] rounded-full flex items-center justify-center text-xs font-bold">4</span>
                    <span>Request is created and queued for processing</span>
                  </li>
                </ol>
              ) : (
                <ol className="text-sm text-gray-600 space-y-2.5">
                  <li className="flex gap-2">
                    <span className="flex-shrink-0 w-5 h-5 bg-[#00C48C]/10 text-[#00C48C] rounded-full flex items-center justify-center text-xs font-bold">1</span>
                    <span>User emails a CSV to matt@moderntax.io</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="flex-shrink-0 w-5 h-5 bg-[#00C48C]/10 text-[#00C48C] rounded-full flex items-center justify-center text-xs font-bold">2</span>
                    <span>Select the sender from the dropdown</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="flex-shrink-0 w-5 h-5 bg-[#00C48C]/10 text-[#00C48C] rounded-full flex items-center justify-center text-xs font-bold">3</span>
                    <span>Upload the CSV file and enter the loan number</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="flex-shrink-0 w-5 h-5 bg-[#00C48C]/10 text-[#00C48C] rounded-full flex items-center justify-center text-xs font-bold">4</span>
                    <span>The request appears under their account as if they submitted it</span>
                  </li>
                </ol>
              )}
            </div>

            {/* Expected CSV format - only show in CSV mode */}
            {mode === 'csv' && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
                <h3 className="text-sm font-semibold text-[#0A1929] mb-3">Expected CSV Columns</h3>
                <div className="text-xs text-gray-600 space-y-1 font-mono bg-gray-50 rounded-lg p-3">
                  <p className="text-[#00C48C] font-semibold">Required:</p>
                  <p>legal_name, tid, tid_kind</p>
                  <p className="text-gray-400 mt-2 font-semibold">Optional:</p>
                  <p>address, city, state, zip_code,</p>
                  <p>years, form, signature_id,</p>
                  <p>first name, last name</p>
                </div>
              </div>
            )}

            {/* Recent intakes */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-[#0A1929] mb-3">Recent Email Intakes</h3>
              {recentIntakes.length === 0 ? (
                <p className="text-sm text-gray-400 italic">No email intakes yet</p>
              ) : (
                <div className="space-y-3">
                  {recentIntakes.map((intake: any) => (
                    <Link
                      key={intake.id}
                      href={`/admin/requests/${intake.id}`}
                      className="block p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-[#0A1929] truncate">
                          {intake.loan_number || 'No loan #'}
                        </span>
                        <span className="text-xs text-gray-400">
                          {new Date(intake.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        {intake.profiles?.full_name || intake.profiles?.email || 'Unknown'} &middot;{' '}
                        {intake.clients?.name || 'Unknown'}
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
