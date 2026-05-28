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

  // Form fields
  const [users, setUsers] = useState<UserOption[]>([]);
  const [selectedEmail, setSelectedEmail] = useState('');
  const [loanNumber, setLoanNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);

  // Mode:
  //   'csv'     - existing CSV / Excel upload path
  //   'manual'  - entities entered inline + free-form attachments
  //               (Enterprise Bank 2026-05-20: secure email + 3rd-party 8821)
  //   'reorder' - clone a prior entity into a fresh request reusing the
  //               existing 8821 (2026-05-28: Soobin's Peter Geyen email — admin
  //               shouldn't need a new CSV + 8821 just to re-pull years)
  const [mode, setMode] = useState<'csv' | 'manual' | 'reorder'>('csv');

  // Reorder-mode state
  interface HistoryItem {
    entity_id: string;
    entity_name: string;
    tid: string;
    tid_masked: string;
    tid_kind: string;
    form_type: string;
    latest_loan_number: string | null;
    latest_status: string;
    latest_created_at: string;
    years_previously_pulled: string[];
    prior_request_count: number;
    transcript_count: number;
    signed_8821_url: string | null;
    signature_age_days: number | null;
    signature_still_valid: boolean;
    signed_8821_valid_window_days: number;
  }
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [reorderEntityId, setReorderEntityId] = useState('');
  const [reorderYears, setReorderYears] = useState<string[]>([]);

  // Manual-mode entity rows
  type ManualEntity = {
    id: string;
    legal_name: string;
    tid: string;
    tid_kind: 'EIN' | 'SSN';
    form: string;
    years: string[];
    address: string;
    city: string;
    state: string;
    zip_code: string;
    first_name: string;
    last_name: string;
    email: string;
  };
  const newRow = (): ManualEntity => ({
    id: Math.random().toString(36).slice(2, 10),
    legal_name: '', tid: '', tid_kind: 'EIN', form: '1120S', years: [],
    address: '', city: '', state: '', zip_code: '',
    first_name: '', last_name: '', email: '',
  });
  const [manualEntities, setManualEntities] = useState<ManualEntity[]>([newRow()]);
  const [attachments, setAttachments] = useState<File[]>([]);
  const attachmentsInputRef = useRef<HTMLInputElement>(null);

  const currentYear = new Date().getFullYear();
  const TAX_YEARS = Array.from({ length: 6 }, (_, i) => String(currentYear - i));

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

  // Reorder mode: when admin picks a processor (selectedEmail) and we're
  // in reorder mode, fetch that processor's historical entities so the
  // dropdown can populate. Re-fires on processor change. Clears the
  // current reorder selection so we don't end up with a stale entity id
  // pointing at the wrong processor.
  useEffect(() => {
    if (mode !== 'reorder') return;
    setReorderEntityId('');
    setReorderYears([]);
    setHistoryItems([]);
    if (!selectedEmail) return;
    const processor = users.find(u => u.email === selectedEmail);
    if (!processor) return;
    setHistoryLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/admin/processor-entity-history?processor_id=${encodeURIComponent(processor.id)}`, { credentials: 'include' });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Failed to load entity history');
          return;
        }
        setHistoryItems(data.items || []);
      } catch (err: any) {
        setError(err?.message || 'Network error loading history');
      } finally {
        setHistoryLoading(false);
      }
    })();
  }, [mode, selectedEmail, users]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
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
      const populated = manualEntities.filter(e => e.legal_name.trim() && e.tid.trim());
      if (populated.length === 0) {
        setError('Add at least one entity with legal name and TIN');
        return;
      }
      // Validate every populated row has both legal_name + tid
      const incomplete = manualEntities.find(e => (e.legal_name.trim() || e.tid.trim()) && (!e.legal_name.trim() || !e.tid.trim()));
      if (incomplete) {
        setError('Every entity row needs both Legal Name and TIN. Remove blank rows or fill them in.');
        return;
      }
    }
    if (mode === 'reorder') {
      if (!reorderEntityId) { setError('Pick an entity from the history dropdown'); return; }
      if (reorderYears.length === 0) { setError('Pick at least one year to re-pull'); return; }
    }

    setSubmitting(true);

    // Reorder mode short-circuits the normal email-intake JSON shape and
    // hits its own endpoint. Driver: 2026-05-28 Matt — reorder lets us
    // satisfy a "re-pull 2024 for Peter Geyen" email in one click without
    // making the processor re-upload a CSV + new 8821.
    if (mode === 'reorder') {
      try {
        const processor = users.find(u => u.email === selectedEmail);
        if (!processor) { setError('Selected user not found in profile cache'); setSubmitting(false); return; }
        const res = await fetch('/api/admin/reorder-from-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            processor_id: processor.id,
            source_entity_id: reorderEntityId,
            new_years: reorderYears,
            loan_number: loanNumber.trim(),
            notes: notes.trim() || undefined,
            reuse_8821: true,
          }),
        });
        const data = await res.json();
        if (!res.ok) { setError(data.error || 'Reorder failed'); return; }
        const head = historyItems.find(h => h.entity_id === reorderEntityId);
        setResult({
          success: true,
          request_id: data.request_id,
          batch_id: '',
          entities_created: 1,
          loan_number: data.loan_number,
          on_behalf_of: {
            email: processor.email,
            name: processor.full_name,
            role: processor.role,
            client: processor.client_name,
          },
          message: `Reorder created for ${head?.entity_name || 'entity'} — years ${data.new_years.join(', ')}. ${data.reused_8821 ? 'Existing 8821 reused (no new signature needed).' : '8821 still needed — entity is in pending state.'}`,
        });
      } catch (err: any) {
        setError(err?.message || 'Reorder failed');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    try {
      const formData = new FormData();
      formData.append('mode', mode);
      if (mode === 'csv' && file) {
        formData.append('file', file);
      } else if (mode === 'manual') {
        const populated = manualEntities.filter(e => e.legal_name.trim() && e.tid.trim());
        formData.append('entities', JSON.stringify(populated.map(e => ({
          legal_name: e.legal_name.trim(),
          tid: e.tid.trim(),
          tid_kind: e.tid_kind,
          form: e.form,
          years: e.years,
          address: e.address.trim() || undefined,
          city: e.city.trim() || undefined,
          state: e.state.trim() || undefined,
          zip_code: e.zip_code.trim() || undefined,
          first_name: e.first_name.trim() || undefined,
          last_name: e.last_name.trim() || undefined,
          email: e.email.trim() || undefined,
        }))));
      }
      // Multi-file attachments (loan notes, prior-vendor 8821 references, etc.)
      for (const a of attachments) formData.append('attachments', a);

      formData.append('sender_email', selectedEmail);
      formData.append('loan_number', loanNumber.trim());
      if (notes.trim()) {
        formData.append('notes', notes.trim());
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
      setManualEntities([newRow()]);
      setAttachments([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (attachmentsInputRef.current) attachmentsInputRef.current.value = '';

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

              {/* Mode tabs */}
              <div className="flex gap-2 mb-5 border-b border-gray-200">
                <button
                  type="button"
                  onClick={() => setMode('csv')}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    mode === 'csv'
                      ? 'border-[#00C48C] text-[#0A1929]'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  CSV / Excel upload
                </button>
                <button
                  type="button"
                  onClick={() => setMode('manual')}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    mode === 'manual'
                      ? 'border-[#00C48C] text-[#0A1929]'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Manual entry (no CSV)
                </button>
                <button
                  type="button"
                  onClick={() => setMode('reorder')}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    mode === 'reorder'
                      ? 'border-[#00C48C] text-[#0A1929]'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                  title="Re-pull an existing entity for new years. Reuses the prior 8821 if it's still within the 120-day validity window — no CSV or new signature needed."
                >
                  Reorder from history
                </button>
              </div>

              <form onSubmit={handleSubmit} className="space-y-5">
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

                {/* File upload — CSV mode only */}
                {mode === 'csv' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    CSV / Excel File <span className="text-red-500">*</span>
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
                          Click to upload CSV or Excel file
                        </p>
                        <p className="text-xs text-gray-400 mt-1">
                          .csv, .xlsx, .xls
                        </p>
                      </div>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv,.xlsx,.xls"
                      onChange={handleFileChange}
                      className="hidden"
                    />
                  </div>
                </div>
                )}

                {/* Manual entity entry — manual mode only */}
                {mode === 'manual' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="block text-sm font-medium text-gray-700">
                      Entities <span className="text-red-500">*</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => setManualEntities([...manualEntities, newRow()])}
                      className="text-xs font-medium text-[#00C48C] hover:text-[#00B07D]"
                    >
                      + Add another entity
                    </button>
                  </div>
                  {manualEntities.map((ent, idx) => (
                    <div key={ent.id} className="border border-gray-200 rounded-lg p-4 bg-gray-50/50 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-gray-500">Entity {idx + 1}</span>
                        {manualEntities.length > 1 && (
                          <button
                            type="button"
                            onClick={() => setManualEntities(manualEntities.filter(e => e.id !== ent.id))}
                            className="text-xs text-red-500 hover:text-red-700"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="sm:col-span-2">
                          <label className="block text-xs font-medium text-gray-600 mb-1">Legal name <span className="text-red-500">*</span></label>
                          <input
                            type="text"
                            value={ent.legal_name}
                            onChange={(e) => setManualEntities(manualEntities.map(x => x.id === ent.id ? { ...x, legal_name: e.target.value } : x))}
                            placeholder="e.g. Enterprise Bank Holdings, LLC"
                            className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-[#00C48C] focus:border-[#00C48C] outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">TIN <span className="text-red-500">*</span></label>
                          <input
                            type="text"
                            value={ent.tid}
                            onChange={(e) => setManualEntities(manualEntities.map(x => x.id === ent.id ? { ...x, tid: e.target.value } : x))}
                            placeholder="EIN or SSN"
                            className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-[#00C48C] focus:border-[#00C48C] outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">TIN kind</label>
                          <select
                            value={ent.tid_kind}
                            onChange={(e) => setManualEntities(manualEntities.map(x => x.id === ent.id ? { ...x, tid_kind: e.target.value as 'EIN' | 'SSN' } : x))}
                            className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-[#00C48C] focus:border-[#00C48C] outline-none"
                          >
                            <option value="EIN">EIN</option>
                            <option value="SSN">SSN / ITIN</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Form</label>
                          <select
                            value={ent.form}
                            onChange={(e) => setManualEntities(manualEntities.map(x => x.id === ent.id ? { ...x, form: e.target.value } : x))}
                            className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-[#00C48C] focus:border-[#00C48C] outline-none"
                          >
                            <option value="1040">1040 (individual)</option>
                            <option value="1065">1065 (partnership)</option>
                            <option value="1120">1120 (C-corp)</option>
                            <option value="1120S">1120S (S-corp)</option>
                            <option value="941">941 (payroll)</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Years</label>
                          <div className="flex flex-wrap gap-1">
                            {TAX_YEARS.map(y => (
                              <button
                                key={y}
                                type="button"
                                onClick={() => setManualEntities(manualEntities.map(x => x.id === ent.id ? {
                                  ...x,
                                  years: x.years.includes(y) ? x.years.filter(yy => yy !== y) : [...x.years, y],
                                } : x))}
                                className={`px-2 py-1 text-xs font-medium rounded ${
                                  ent.years.includes(y)
                                    ? 'bg-[#00C48C] text-white'
                                    : 'bg-white text-gray-600 border border-gray-300 hover:border-[#00C48C]'
                                }`}
                              >
                                {y}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <input
                            type="text" value={ent.first_name}
                            onChange={(e) => setManualEntities(manualEntities.map(x => x.id === ent.id ? { ...x, first_name: e.target.value } : x))}
                            placeholder="Signer first name"
                            className="px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-[#00C48C] focus:border-[#00C48C] outline-none"
                          />
                          <input
                            type="text" value={ent.last_name}
                            onChange={(e) => setManualEntities(manualEntities.map(x => x.id === ent.id ? { ...x, last_name: e.target.value } : x))}
                            placeholder="Signer last name"
                            className="px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-[#00C48C] focus:border-[#00C48C] outline-none"
                          />
                          <input
                            type="email" value={ent.email}
                            onChange={(e) => setManualEntities(manualEntities.map(x => x.id === ent.id ? { ...x, email: e.target.value } : x))}
                            placeholder="Signer email (auto-fires 8821)"
                            className="px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-[#00C48C] focus:border-[#00C48C] outline-none"
                          />
                        </div>
                        <details className="sm:col-span-2">
                          <summary className="text-xs font-medium text-gray-500 cursor-pointer hover:text-gray-700">Address (optional)</summary>
                          <div className="mt-2 grid grid-cols-1 sm:grid-cols-4 gap-2">
                            <input type="text" value={ent.address}
                              onChange={(e) => setManualEntities(manualEntities.map(x => x.id === ent.id ? { ...x, address: e.target.value } : x))}
                              placeholder="Street" className="sm:col-span-2 px-3 py-2 border border-gray-300 rounded text-sm outline-none"/>
                            <input type="text" value={ent.city}
                              onChange={(e) => setManualEntities(manualEntities.map(x => x.id === ent.id ? { ...x, city: e.target.value } : x))}
                              placeholder="City" className="px-3 py-2 border border-gray-300 rounded text-sm outline-none"/>
                            <div className="grid grid-cols-2 gap-2">
                              <input type="text" value={ent.state}
                                onChange={(e) => setManualEntities(manualEntities.map(x => x.id === ent.id ? { ...x, state: e.target.value } : x))}
                                placeholder="ST" className="px-3 py-2 border border-gray-300 rounded text-sm outline-none"/>
                              <input type="text" value={ent.zip_code}
                                onChange={(e) => setManualEntities(manualEntities.map(x => x.id === ent.id ? { ...x, zip_code: e.target.value } : x))}
                                placeholder="ZIP" className="px-3 py-2 border border-gray-300 rounded text-sm outline-none"/>
                            </div>
                          </div>
                        </details>
                      </div>
                    </div>
                  ))}
                </div>
                )}

                {/* Reorder-from-history mode */}
                {mode === 'reorder' && (
                <div className="space-y-4 border border-gray-200 rounded-lg p-4 bg-gray-50/30">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      Historical entity <span className="text-red-500">*</span>
                    </label>
                    {!selectedEmail ? (
                      <p className="text-xs text-gray-500 italic">Pick a processor above to load their history.</p>
                    ) : historyLoading ? (
                      <p className="text-xs text-gray-500 italic">Loading history…</p>
                    ) : historyItems.length === 0 ? (
                      <p className="text-xs text-amber-700">No prior entities found for this processor.</p>
                    ) : (
                      <select
                        value={reorderEntityId}
                        onChange={(e) => setReorderEntityId(e.target.value)}
                        className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#00C48C] focus:border-[#00C48C] outline-none"
                      >
                        <option value="">Pick a prior entity to reorder…</option>
                        {historyItems.map((h) => (
                          <option key={h.entity_id} value={h.entity_id}>
                            {h.entity_name} · {h.form_type} · TIN {h.tid_masked} · prior years {h.years_previously_pulled.join(', ') || '—'} · loan {h.latest_loan_number || '—'}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* Selected entity card — shows context so admin knows what they're cloning */}
                  {reorderEntityId && (() => {
                    const h = historyItems.find(x => x.entity_id === reorderEntityId);
                    if (!h) return null;
                    return (
                      <div className="border border-gray-200 bg-white rounded-lg p-3 text-xs space-y-1">
                        <div className="font-semibold text-mt-dark">{h.entity_name} <span className="text-gray-500 font-normal">({h.form_type}, TIN {h.tid_masked})</span></div>
                        <div className="text-gray-600">Previously pulled years: <span className="font-mono">{h.years_previously_pulled.join(', ') || '—'}</span> · {h.transcript_count} transcript{h.transcript_count === 1 ? '' : 's'} on file across {h.prior_request_count} prior request{h.prior_request_count === 1 ? '' : 's'}</div>
                        <div className={h.signature_still_valid ? 'text-emerald-700' : 'text-amber-700'}>
                          {h.signed_8821_url
                            ? h.signature_still_valid
                              ? `✓ Signed 8821 on file (${h.signature_age_days}d old, within ${h.signed_8821_valid_window_days}d window) — will be reused, no new signature needed.`
                              : `⚠ Signed 8821 on file but ${h.signature_age_days}d old (>${h.signed_8821_valid_window_days}d window) — a fresh 8821 will be required.`
                            : '⚠ No 8821 on file — a fresh one will be required.'}
                        </div>
                      </div>
                    );
                  })()}

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      New year(s) to pull <span className="text-red-500">*</span>
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {TAX_YEARS.map((y) => {
                        const checked = reorderYears.includes(y);
                        return (
                          <button
                            type="button"
                            key={y}
                            onClick={() =>
                              setReorderYears((prev) => prev.includes(y) ? prev.filter(z => z !== y) : [...prev, y].sort())
                            }
                            className={`px-3 py-1.5 rounded text-sm font-mono border transition-colors ${
                              checked
                                ? 'bg-[#00C48C] text-white border-[#00C48C]'
                                : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400'
                            }`}
                          >
                            {y}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[11px] text-gray-500 mt-1.5">Pick the years for the new pull. Existing years stay on the prior entity record — this creates a brand-new request.</p>
                  </div>
                </div>
                )}

                {/* Attachments (any mode, optional) */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Attachments <span className="text-gray-400">(optional — loan note, prior-vendor 8821, etc.)</span>
                  </label>
                  <div
                    onClick={() => attachmentsInputRef.current?.click()}
                    className="border-2 border-dashed rounded-lg p-4 text-center cursor-pointer border-gray-300 hover:border-gray-400 bg-gray-50/50"
                  >
                    {attachments.length === 0 ? (
                      <p className="text-sm text-gray-500">Click to attach one or more files (PDFs, images, anything)</p>
                    ) : (
                      <div className="space-y-1 text-left">
                        {attachments.map((a, i) => (
                          <div key={i} className="flex items-center justify-between text-sm">
                            <span className="text-gray-700 truncate">📎 {a.name} <span className="text-xs text-gray-400">({(a.size / 1024).toFixed(1)}KB)</span></span>
                            <button
                              type="button"
                              onClick={(ev) => { ev.stopPropagation(); setAttachments(attachments.filter((_, j) => j !== i)); }}
                              className="text-xs text-red-500 hover:text-red-700 ml-2"
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                        <p className="text-xs text-gray-400 italic mt-2">Click to add more</p>
                      </div>
                    )}
                    <input
                      ref={attachmentsInputRef}
                      type="file"
                      multiple
                      onChange={(e) => {
                        const files = Array.from(e.target.files || []);
                        if (files.length) setAttachments([...attachments, ...files]);
                      }}
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
            </div>

            {/* Expected CSV format */}
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
