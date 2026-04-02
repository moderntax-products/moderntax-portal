'use client';

import { useState, useEffect, useCallback } from 'react';

interface ClearfirmEntity {
  id: string;
  entity_name: string;
  tid: string;
  tid_kind: string;
  form_type: string;
  status: string;
  signed_8821_url: string | null;
  signer_email: string | null;
  signer_first_name: string | null;
  signer_last_name: string | null;
  signature_id: string | null;
  request_id: string;
  loan_number: string;
  intake_method: string;
  request_created_at: string;
}

interface Designee {
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  ptin: string;
  caf: string;
}

interface ProcessResult {
  entityId: string;
  entityName: string;
  status: string;
  signatureRequestId?: string;
  storagePath?: string;
  error?: string;
}

export function ClearfirmBotPanel() {
  const [pending, setPending] = useState<ClearfirmEntity[]>([]);
  const [processing, setProcessing] = useState<ClearfirmEntity[]>([]);
  const [completed, setCompleted] = useState<ClearfirmEntity[]>([]);
  const [designee, setDesignee] = useState<Designee | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<ProcessResult[]>([]);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'pending' | 'processing' | 'completed'>('pending');

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/clearfirm-bot');
      const data = await res.json();
      if (res.ok) {
        setPending(data.pending || []);
        setProcessing(data.processing || []);
        setCompleted(data.completed || []);
        setDesignee(data.designee);
      } else {
        setError(data.error || 'Failed to load');
      }
    } catch {
      setError('Failed to connect');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = (entities: ClearfirmEntity[]) => {
    setSelectedIds(new Set(entities.map((e) => e.id)));
  };

  const deselectAll = () => setSelectedIds(new Set());

  const processEntities = async (action: 'send_8821' | 'download_template') => {
    if (selectedIds.size === 0) return;
    setActionLoading(true);
    setResults([]);
    setError('');

    try {
      const res = await fetch('/api/admin/clearfirm-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityIds: Array.from(selectedIds),
          action,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setResults(data.results || []);
        setSelectedIds(new Set());
        // Refresh data
        await fetchData();
      } else {
        setError(data.error || 'Processing failed');
      }
    } catch {
      setError('Failed to process');
    } finally {
      setActionLoading(false);
    }
  };

  const maskTid = (tid: string) => {
    if (!tid || tid.length < 4) return '***';
    return '***-**-' + tid.slice(-4);
  };

  const formatDate = (d: string) =>
    new Date(d).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });

  const getFormLabel = (ft: string) => {
    const labels: Record<string, string> = {
      '1040': 'Individual (1040)',
      '1065': 'Partnership (1065)',
      '1120': 'Corporation (1120)',
      '1120S': 'S-Corp (1120S)',
    };
    return labels[ft] || ft;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Designee Credentials Card */}
      {designee && (
        <div className="bg-gradient-to-r from-blue-900 to-blue-800 rounded-xl p-6 text-white">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              Clearfirm Designee Credentials
            </h3>
            <span className="px-3 py-1 bg-green-500/20 text-green-300 rounded-full text-xs font-semibold">
              Active
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-blue-300 text-xs uppercase tracking-wide">Designee</p>
              <p className="font-semibold">{designee.name}</p>
            </div>
            <div>
              <p className="text-blue-300 text-xs uppercase tracking-wide">PTIN</p>
              <p className="font-mono font-semibold">{designee.ptin}</p>
            </div>
            <div>
              <p className="text-blue-300 text-xs uppercase tracking-wide">CAF Number</p>
              <p className="font-mono font-semibold">{designee.caf}</p>
            </div>
            <div>
              <p className="text-blue-300 text-xs uppercase tracking-wide">Address</p>
              <p className="text-xs">{designee.address}<br />{designee.city}, {designee.state} {designee.zip}</p>
            </div>
          </div>
        </div>
      )}

      {/* Stats Bar */}
      <div className="grid grid-cols-3 gap-4">
        <button
          onClick={() => setActiveTab('pending')}
          className={`p-4 rounded-lg text-center transition-colors ${
            activeTab === 'pending' ? 'bg-amber-50 border-2 border-amber-300' : 'bg-white border border-gray-200 hover:bg-gray-50'
          }`}
        >
          <p className="text-2xl font-bold text-amber-600">{pending.length}</p>
          <p className="text-sm text-gray-600">Pending 8821</p>
        </button>
        <button
          onClick={() => setActiveTab('processing')}
          className={`p-4 rounded-lg text-center transition-colors ${
            activeTab === 'processing' ? 'bg-blue-50 border-2 border-blue-300' : 'bg-white border border-gray-200 hover:bg-gray-50'
          }`}
        >
          <p className="text-2xl font-bold text-blue-600">{processing.length}</p>
          <p className="text-sm text-gray-600">In Progress</p>
        </button>
        <button
          onClick={() => setActiveTab('completed')}
          className={`p-4 rounded-lg text-center transition-colors ${
            activeTab === 'completed' ? 'bg-green-50 border-2 border-green-300' : 'bg-white border border-gray-200 hover:bg-gray-50'
          }`}
        >
          <p className="text-2xl font-bold text-green-600">{completed.length}</p>
          <p className="text-sm text-gray-600">Completed</p>
        </button>
      </div>

      {/* Action Bar (for pending tab) */}
      {activeTab === 'pending' && pending.length > 0 && (
        <div className="bg-white rounded-lg shadow p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => selectedIds.size === pending.length ? deselectAll() : selectAll(pending)}
              className="text-sm text-blue-600 hover:text-blue-800 font-medium"
            >
              {selectedIds.size === pending.length ? 'Deselect All' : `Select All (${pending.length})`}
            </button>
            {selectedIds.size > 0 && (
              <span className="text-sm text-gray-500">
                {selectedIds.size} selected
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => processEntities('send_8821')}
              disabled={selectedIds.size === 0 || actionLoading}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {actionLoading ? (
                <>
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Processing...
                </>
              ) : (
                <>Send 8821 via Dropbox Sign ({selectedIds.size})</>
              )}
            </button>
            <button
              onClick={() => processEntities('download_template')}
              disabled={selectedIds.size === 0 || actionLoading}
              className="px-4 py-2 bg-gray-600 text-white text-sm font-medium rounded-lg hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Download Templates ({selectedIds.size})
            </button>
          </div>
        </div>
      )}

      {/* Results Banner */}
      {results.length > 0 && (
        <div className="bg-white rounded-lg shadow p-4">
          <h4 className="text-sm font-semibold text-gray-700 mb-2">Processing Results</h4>
          <div className="space-y-1">
            {results.map((r) => (
              <div key={r.entityId} className={`flex items-center justify-between text-sm px-3 py-2 rounded ${
                r.status === 'error' ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
              }`}>
                <span className="font-medium">{r.entityName}</span>
                <span className="text-xs">
                  {r.status === 'sent' && `Sent (${r.signatureRequestId?.slice(0, 12)}...)`}
                  {r.status === 'template_ready' && 'Template downloaded'}
                  {r.status === 'error' && r.error}
                </span>
              </div>
            ))}
          </div>
          <button
            onClick={() => setResults([])}
            className="mt-2 text-xs text-gray-500 hover:text-gray-700"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 text-red-500 hover:text-red-700 underline">Dismiss</button>
        </div>
      )}

      {/* Entity Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        {activeTab === 'pending' && (
          <>
            <div className="px-6 py-4 border-b border-gray-200 bg-amber-50">
              <h3 className="text-sm font-semibold text-amber-800">
                Pending 8821 Requests — Awaiting Signature
              </h3>
              <p className="text-xs text-amber-600 mt-1">
                These Clearfirm entities need 8821 forms sent for signature. Designee: {designee?.name} (PTIN: {designee?.ptin})
              </p>
            </div>
            {pending.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 w-8"></th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Entity</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">TIN</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Form</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Signer</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Loan #</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Received</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {pending.map((entity) => (
                      <tr
                        key={entity.id}
                        className={`hover:bg-gray-50 transition-colors cursor-pointer ${
                          selectedIds.has(entity.id) ? 'bg-blue-50' : ''
                        }`}
                        onClick={() => toggleSelect(entity.id)}
                      >
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(entity.id)}
                            onChange={() => toggleSelect(entity.id)}
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-sm font-medium text-gray-900">{entity.entity_name}</p>
                        </td>
                        <td className="px-4 py-3">
                          <code className="text-xs font-mono text-gray-600">{maskTid(entity.tid)}</code>
                          <span className="ml-1 text-xs text-gray-400">{entity.tid_kind}</span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${
                            entity.form_type === '1040' ? 'bg-purple-100 text-purple-700' : 'bg-orange-100 text-orange-700'
                          }`}>
                            {getFormLabel(entity.form_type)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-sm text-gray-700">
                            {entity.signer_email || <span className="text-gray-400 italic">No signer</span>}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <code className="text-xs font-mono text-gray-600">{entity.loan_number}</code>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500">
                          {formatDate(entity.request_created_at)}
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">
                            {entity.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-8 text-center text-gray-500">No pending entities</div>
            )}
          </>
        )}

        {activeTab === 'processing' && (
          <>
            <div className="px-6 py-4 border-b border-gray-200 bg-blue-50">
              <h3 className="text-sm font-semibold text-blue-800">In Progress — 8821 Signed, Awaiting Transcripts</h3>
            </div>
            {processing.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Entity</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Form</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Loan #</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Status</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Signature ID</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {processing.map((entity) => (
                      <tr key={entity.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">{entity.entity_name}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${
                            entity.form_type === '1040' ? 'bg-purple-100 text-purple-700' : 'bg-orange-100 text-orange-700'
                          }`}>
                            {getFormLabel(entity.form_type)}
                          </span>
                        </td>
                        <td className="px-4 py-3"><code className="text-xs font-mono text-gray-600">{entity.loan_number}</code></td>
                        <td className="px-4 py-3">
                          <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-700">
                            {entity.status}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <code className="text-xs font-mono text-gray-500">{entity.signature_id?.slice(0, 16)}...</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-8 text-center text-gray-500">No in-progress entities</div>
            )}
          </>
        )}

        {activeTab === 'completed' && (
          <>
            <div className="px-6 py-4 border-b border-gray-200 bg-green-50">
              <h3 className="text-sm font-semibold text-green-800">Completed — Transcripts Delivered</h3>
            </div>
            {completed.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Entity</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Form</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Loan #</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {completed.map((entity) => (
                      <tr key={entity.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">{entity.entity_name}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${
                            entity.form_type === '1040' ? 'bg-purple-100 text-purple-700' : 'bg-orange-100 text-orange-700'
                          }`}>
                            {getFormLabel(entity.form_type)}
                          </span>
                        </td>
                        <td className="px-4 py-3"><code className="text-xs font-mono text-gray-600">{entity.loan_number}</code></td>
                        <td className="px-4 py-3">
                          <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">
                            Completed
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-8 text-center text-gray-500">No completed entities yet</div>
            )}
          </>
        )}
      </div>

      {/* Embedded Browser Tool Reference */}
      <div className="bg-gray-50 rounded-lg border border-gray-200 p-6">
        <h4 className="text-sm font-semibold text-gray-700 mb-2">Manual Batch Tool (Browser Console)</h4>
        <p className="text-xs text-gray-500 mb-3">
          For manual processing outside the portal, copy this script to your browser console on HelloSign:
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => {
              const script = `// ModernTax 8821 Clearfirm Bot — Auto-fills designee: ${designee?.name || 'LaTonya Holmes'}
// PTIN: ${designee?.ptin || '0316-30210'} | CAF: ${designee?.caf || '0315-23541R'}
// Paste this in HelloSign console after opening a template

(function() {
  const DESIGNEE = ${JSON.stringify(designee || {
    name: 'LaTonya Holmes',
    ptin: '0316-30210',
    caf: '0315-23541R',
    address: '8465 Houndstooth Enclave Dr',
    city: 'New Port Richey',
    state: 'FL',
    zip: '34655'
  }, null, 2)};

  document.querySelectorAll('input').forEach(i => {
    const ph = (i.placeholder || '').toLowerCase();
    const nm = (i.name || '').toLowerCase();
    if (ph.includes('designee') || nm.includes('designee') || ph.includes('appointee')) {
      i.value = DESIGNEE.name;
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (ph.includes('ptin') || nm.includes('ptin')) {
      i.value = DESIGNEE.ptin;
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (ph.includes('caf') || nm.includes('caf')) {
      i.value = DESIGNEE.caf;
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  alert('Designee fields filled: ' + DESIGNEE.name + ' | PTIN: ' + DESIGNEE.ptin + ' | CAF: ' + DESIGNEE.caf);
})();`;
              navigator.clipboard.writeText(script);
              alert('Script copied to clipboard!');
            }}
            className="px-3 py-1.5 bg-gray-200 text-gray-700 text-xs rounded hover:bg-gray-300"
          >
            Copy Designee Fill Script
          </button>
        </div>
      </div>
    </div>
  );
}
