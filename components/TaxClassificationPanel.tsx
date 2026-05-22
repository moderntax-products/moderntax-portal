'use client';

/**
 * Tax Classification Status panel — rendered on the admin compliance
 * report page below the headline summary. Surfaces:
 *  - Borrower-declared form (from intake)
 *  - IRS-of-record filing requirement (from BMF Entity)
 *  - Form 2553 election status (set by an admin after a PPS lookup)
 *  - Mismatch headline + suggested borrower action (computed)
 *  - "Send Borrower Communication" button — opens mailto with prepopulated body
 *  - "Update 2553 Status" inline form — admin fills in post-PPS-call
 */

import { useState, useEffect, useCallback } from 'react';

interface Form2553Status {
  received_date: string | null;
  effective_date: string | null;
  processing_status: 'pending' | 'accepted' | 'rejected' | 'not_on_file' | null;
  raw_notes: string;
}

interface DetectionResult {
  entity_id: string;
  entity_name: string;
  declared_form: string;
  irs_form: string | null;
  check_requested: boolean;
  form_2553_status: Form2553Status | null;
  mismatch: {
    detected_at: string;
    declared_form: string;
    irs_form: string | null;
    source: string;
    severity: 'WARNING' | 'CRITICAL';
    message: string;
    suggested_borrower_action: string;
    form_2553_relevant: boolean;
  } | null;
  ui_block: {
    headline: string;
    bullets: string[];
    action: string;
  } | null;
  borrower_communication: { subject: string; body: string } | null;
  bmf_entity_present: boolean;
  recent_transcript_was_stub: boolean;
}

export function TaxClassificationPanel({ entityId }: { entityId: string }) {
  const [data, setData] = useState<DetectionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [show2553Form, setShow2553Form] = useState(false);
  const [pending, setPending] = useState(false);

  const [form2553Draft, setForm2553Draft] = useState<Form2553Status>({
    received_date: '',
    effective_date: '',
    processing_status: 'pending',
    raw_notes: '',
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/tax-classification/${entityId}`, { cache: 'no-store' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || `status ${res.status}`);
        return;
      }
      const result: DetectionResult = await res.json();
      setData(result);
      if (result.form_2553_status) setForm2553Draft(result.form_2553_status);
    } catch (err: any) {
      setError(err?.message || 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, [entityId]);

  useEffect(() => { refresh(); }, [refresh]);

  const save2553 = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/tax-classification/${entityId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          form_2553_status: {
            received_date: form2553Draft.received_date || null,
            effective_date: form2553Draft.effective_date || null,
            processing_status: form2553Draft.processing_status || null,
            raw_notes: form2553Draft.raw_notes || '',
          },
          set_check_requested: true,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || `status ${res.status}`);
        return;
      }
      const result: DetectionResult = await res.json();
      setData(result);
      setShow2553Form(false);
    } catch (err: any) {
      setError(err?.message || 'save failed');
    } finally {
      setPending(false);
    }
  };

  const toggleCheckRequested = async () => {
    if (!data) return;
    setPending(true);
    try {
      await fetch(`/api/admin/tax-classification/${entityId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tax_classification_check_requested: !data.check_requested }),
      });
      await refresh();
    } finally { setPending(false); }
  };

  const openBorrowerMailto = () => {
    if (!data?.borrower_communication) return;
    const { subject, body } = data.borrower_communication;
    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  if (loading) return (
    <div className="bg-white border border-gray-200 rounded-lg p-5 mb-6">
      <h3 className="text-sm font-semibold text-gray-700">Tax Classification Status</h3>
      <p className="text-xs text-gray-500 mt-2">Loading…</p>
    </div>
  );

  if (error) return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-5 mb-6">
      <h3 className="text-sm font-semibold text-red-900">Tax Classification Status — load failed</h3>
      <p className="text-xs text-red-700 mt-2">{error}</p>
    </div>
  );

  if (!data) return null;

  const sev = data.mismatch?.severity;
  const containerClass = sev === 'CRITICAL'
    ? 'bg-red-50 border-red-300'
    : sev === 'WARNING'
    ? 'bg-amber-50 border-amber-300'
    : 'bg-emerald-50 border-emerald-300';
  const iconColor = sev === 'CRITICAL' ? 'text-red-700' : sev === 'WARNING' ? 'text-amber-700' : 'text-emerald-700';

  const statusBadge = (s: string | null) => {
    const map: Record<string, string> = {
      pending: 'bg-amber-100 text-amber-900',
      accepted: 'bg-emerald-100 text-emerald-900',
      rejected: 'bg-red-100 text-red-900',
      not_on_file: 'bg-gray-200 text-gray-900',
    };
    return s ? <span className={`px-2 py-0.5 rounded text-xs font-semibold ${map[s] || 'bg-gray-100 text-gray-700'}`}>{s}</span> : <span className="text-gray-500 text-xs italic">not yet looked up</span>;
  };

  return (
    <section className={`border rounded-lg p-5 mb-6 ${containerClass}`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className={`text-base font-bold ${iconColor}`}>
            {sev ? (sev === 'CRITICAL' ? '🚫' : '⚠️') : '✅'} Tax Classification Status
          </h3>
          {!sev && (
            <p className="text-xs text-emerald-800 mt-0.5">No classification mismatch detected.</p>
          )}
        </div>
        <button
          onClick={toggleCheckRequested}
          disabled={pending}
          className="text-xs font-semibold underline text-gray-700 hover:text-gray-900 disabled:opacity-50"
          title="Toggle whether the PPS call agent asks for 2553 status"
        >
          {data.check_requested ? '☑ 2553 check enabled' : '☐ Enable 2553 check'}
        </button>
      </div>

      {/* Three-row identity table */}
      <table className="w-full text-sm mb-4 border-collapse">
        <tbody>
          <tr className="border-b border-gray-200">
            <td className="py-1.5 text-gray-600 w-1/3">Borrower-declared</td>
            <td className="py-1.5 font-mono font-semibold">{data.declared_form || '(blank)'}</td>
          </tr>
          <tr className="border-b border-gray-200">
            <td className="py-1.5 text-gray-600">IRS-of-record (BMF Entity)</td>
            <td className="py-1.5 font-mono font-semibold">
              {data.bmf_entity_present
                ? (data.irs_form || data.declared_form || '(not extracted)')
                : <span className="text-gray-500 italic font-sans">no BMF Entity transcript on file</span>}
            </td>
          </tr>
          <tr>
            <td className="py-1.5 text-gray-600">Form 2553 election status</td>
            <td className="py-1.5">
              {data.form_2553_status ? (
                <div className="text-sm">
                  <div className="flex items-center gap-2 mb-1">{statusBadge(data.form_2553_status.processing_status)}</div>
                  <div className="text-xs text-gray-700 mt-0.5">
                    Received: <span className="font-mono">{data.form_2553_status.received_date || '—'}</span>
                    {' · '}
                    Effective: <span className="font-mono">{data.form_2553_status.effective_date || '—'}</span>
                  </div>
                  {data.form_2553_status.raw_notes && (
                    <div className="text-xs text-gray-600 mt-1 italic">&ldquo;{data.form_2553_status.raw_notes}&rdquo;</div>
                  )}
                </div>
              ) : statusBadge(null)}
            </td>
          </tr>
        </tbody>
      </table>

      {/* Mismatch headline + action */}
      {data.ui_block && (
        <div className="bg-white/50 rounded p-3 mb-3 border border-gray-200">
          <div className="text-sm font-semibold mb-1">{data.ui_block.headline}</div>
          <ul className="text-xs text-gray-700 space-y-0.5 mb-2">
            {data.ui_block.bullets.map((b, i) => <li key={i}>• {b}</li>)}
          </ul>
          <div className="text-xs mt-2 pt-2 border-t border-gray-200">
            <span className="font-semibold">Suggested borrower action: </span>
            <span className="text-gray-800">{data.ui_block.action}</span>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 mt-2">
        {data.borrower_communication && (
          <button
            onClick={openBorrowerMailto}
            className="px-3 py-1.5 bg-mt-dark text-white text-xs font-semibold rounded hover:bg-mt-dark/90"
          >
            ✉ Send Borrower Communication
          </button>
        )}
        <button
          onClick={() => setShow2553Form(s => !s)}
          className="px-3 py-1.5 bg-white text-mt-dark border border-gray-300 text-xs font-semibold rounded hover:bg-gray-50"
        >
          {show2553Form ? 'Cancel' : (data.form_2553_status ? 'Update 2553 Status' : 'Record 2553 Status')}
        </button>
        <button
          onClick={refresh}
          className="px-3 py-1.5 text-xs text-gray-700 hover:text-gray-900 underline"
        >
          Re-run detection
        </button>
      </div>

      {/* 2553 inline form */}
      {show2553Form && (
        <div className="mt-4 p-4 bg-white rounded border border-gray-300">
          <h4 className="text-sm font-semibold mb-2">Record Form 2553 status from IRS PPS call</h4>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Received date</label>
              <input type="date" value={form2553Draft.received_date || ''}
                onChange={e => setForm2553Draft({ ...form2553Draft, received_date: e.target.value })}
                className="w-full px-2 py-1 border border-gray-300 rounded text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Effective date</label>
              <input type="date" value={form2553Draft.effective_date || ''}
                onChange={e => setForm2553Draft({ ...form2553Draft, effective_date: e.target.value })}
                className="w-full px-2 py-1 border border-gray-300 rounded text-sm" />
            </div>
          </div>
          <div className="mb-3">
            <label className="block text-xs font-medium text-gray-600 mb-1">Processing status</label>
            <select value={form2553Draft.processing_status || ''}
              onChange={e => setForm2553Draft({ ...form2553Draft, processing_status: e.target.value as any })}
              className="w-full px-2 py-1 border border-gray-300 rounded text-sm">
              <option value="">(select)</option>
              <option value="pending">Pending</option>
              <option value="accepted">Accepted</option>
              <option value="rejected">Rejected</option>
              <option value="not_on_file">Not on file</option>
            </select>
          </div>
          <div className="mb-3">
            <label className="block text-xs font-medium text-gray-600 mb-1">Notes from IRS agent</label>
            <textarea rows={3} value={form2553Draft.raw_notes}
              onChange={e => setForm2553Draft({ ...form2553Draft, raw_notes: e.target.value })}
              className="w-full px-2 py-1 border border-gray-300 rounded text-sm font-mono" />
          </div>
          <button onClick={save2553} disabled={pending}
            className="px-3 py-1.5 bg-mt-dark text-white text-xs font-semibold rounded disabled:opacity-50">
            {pending ? 'Saving…' : 'Save 2553 status'}
          </button>
        </div>
      )}
    </section>
  );
}
