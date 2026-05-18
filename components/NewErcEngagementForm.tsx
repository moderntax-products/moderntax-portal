'use client';

/**
 * Admin form: spin up a new ERC recovery engagement on an entity.
 * Posts to /api/admin/erc-engagement/create.
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface EntityHit {
  id: string;
  entity_name: string;
  tid: string;
  status: string;
  client_name: string | null;
  loan_number: string | null;
}

interface EventRow {
  tax_quarter: string;
  period_ending: string;
  form_type: string;
  issued_on: string;
  amount: string; // string for input, parsed to number on submit
  returned_on: string;
}

const blankEvent = (): EventRow => ({
  tax_quarter: '',
  period_ending: '',
  form_type: '941',
  issued_on: '',
  amount: '',
  returned_on: '',
});

export function NewErcEngagementForm() {
  const router = useRouter();
  const [searchQ, setSearchQ] = useState('');
  const [hits, setHits] = useState<EntityHit[]>([]);
  const [selectedEntity, setSelectedEntity] = useState<EntityHit | null>(null);
  const [tokenOverride, setTokenOverride] = useState('');
  const [events, setEvents] = useState<EventRow[]>([blankEvent()]);
  const [invoiceNum, setInvoiceNum] = useState('');
  const [invoiceAmount, setInvoiceAmount] = useState('');
  const [invoicePayUrl, setInvoicePayUrl] = useState('');
  const [sendKickoff, setSendKickoff] = useState(false);
  const [kickoffEmail, setKickoffEmail] = useState('');
  const [kickoffName, setKickoffName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ token: string; tracking_url: string; admin_url: string; kickoff_email_sent: boolean } | null>(null);

  // Entity search (debounced)
  useEffect(() => {
    if (selectedEntity) return;
    const q = searchQ.trim();
    if (q.length < 2) { setHits([]); return; }
    const timer = setTimeout(() => {
      fetch(`/api/admin/entity-search?q=${encodeURIComponent(q)}`)
        .then(r => r.ok ? r.json() : { entities: [] })
        .then(d => setHits(d.entities || []))
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQ, selectedEntity]);

  const totalRecoverable = events.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  const updateEvent = (idx: number, patch: Partial<EventRow>) => {
    setEvents(prev => prev.map((e, i) => i === idx ? { ...e, ...patch } : e));
  };

  const removeEvent = (idx: number) => {
    setEvents(prev => prev.length === 1 ? prev : prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);

    if (!selectedEntity) { setError('Pick an entity'); return; }
    if (events.some(ev => !ev.tax_quarter || !ev.issued_on || !ev.amount)) {
      setError('Every event needs tax_quarter, issued_on, and amount'); return;
    }
    if (sendKickoff && !kickoffEmail) { setError('Kickoff email recipient required'); return; }

    setSubmitting(true);
    try {
      const body: any = {
        entity_id: selectedEntity.id,
        token: tokenOverride || undefined,
        events: events.map(e => ({
          tax_quarter: e.tax_quarter.trim(),
          period_ending: e.period_ending.trim() || undefined,
          form_type: e.form_type.trim() || '941',
          issued_on: e.issued_on.trim(),
          amount: Number(e.amount),
          status: 'undelivered',
          returned_on: e.returned_on.trim() || e.issued_on.trim(),
        })),
      };
      if (invoiceNum && invoicePayUrl) {
        body.invoice = {
          mercury_invoice_number: invoiceNum,
          amount: Number(invoiceAmount) || 0,
          pay_url: invoicePayUrl,
        };
      }
      if (sendKickoff) {
        body.kickoff_email = { to_email: kickoffEmail, to_name: kickoffName };
      }

      const res = await fetch('/api/admin/erc-engagement/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to create');
        return;
      }
      setResult(data);
      // Auto-redirect to the detail page after a moment
      setTimeout(() => router.push(`/admin/erc-engagements/${data.token}`), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-6">
        <h2 className="text-lg font-bold text-emerald-900 mb-2">✓ Engagement created</h2>
        <p className="text-sm text-emerald-800 mb-3">
          Token: <code className="bg-white px-1 rounded">{result.token}</code>
          {result.kickoff_email_sent && <span className="ml-3 text-xs font-medium">Kickoff email sent ✓</span>}
        </p>
        <div className="space-y-1 text-sm">
          <div>Tracking page: <a href={result.tracking_url} target="_blank" rel="noopener noreferrer" className="text-emerald-700 underline">{result.tracking_url}</a></div>
          <div>Admin page: <a href={result.admin_url} className="text-emerald-700 underline">{result.admin_url}</a></div>
        </div>
        <p className="text-xs text-emerald-700 mt-3 italic">Redirecting to detail page…</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* 1. Entity selection */}
      <section className="bg-white border rounded-lg p-5">
        <h2 className="text-base font-bold text-gray-900 mb-3">1. Entity</h2>
        {selectedEntity ? (
          <div className="bg-emerald-50 border border-emerald-200 rounded p-3 flex justify-between items-start">
            <div>
              <div className="font-medium">{selectedEntity.entity_name}</div>
              <div className="text-xs text-gray-600">{selectedEntity.client_name} · TID {selectedEntity.tid} · loan {selectedEntity.loan_number || '—'} · {selectedEntity.status}</div>
            </div>
            <button type="button" onClick={() => { setSelectedEntity(null); setSearchQ(''); }} className="text-xs text-red-700 hover:text-red-900 underline">change</button>
          </div>
        ) : (
          <>
            <input
              type="text"
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              placeholder="Search by entity name or TID (min 2 chars)"
              className="w-full border rounded px-3 py-2 text-sm"
            />
            {hits.length > 0 && (
              <ul className="mt-2 border rounded divide-y max-h-60 overflow-y-auto">
                {hits.map(h => (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() => { setSelectedEntity(h); setHits([]); }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                    >
                      <div className="font-medium">{h.entity_name}</div>
                      <div className="text-xs text-gray-500">{h.client_name} · TID {h.tid} · loan {h.loan_number || '—'} · {h.status}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {/* 2. Returned-check events */}
      <section className="bg-white border rounded-lg p-5">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-base font-bold text-gray-900">2. Returned ERC checks</h2>
          <span className="text-sm text-gray-700">
            Total recoverable: <strong className="text-emerald-700">${totalRecoverable.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>
          </span>
        </div>
        <div className="space-y-3">
          {events.map((ev, idx) => (
            <div key={idx} className="grid grid-cols-1 md:grid-cols-6 gap-2 items-center">
              <input value={ev.tax_quarter} onChange={e => updateEvent(idx, { tax_quarter: e.target.value })} placeholder="2021-Q3" className="border rounded px-2 py-1 text-sm" />
              <input value={ev.period_ending} onChange={e => updateEvent(idx, { period_ending: e.target.value })} placeholder="09-30-2021" className="border rounded px-2 py-1 text-sm font-mono text-xs" />
              <input value={ev.form_type} onChange={e => updateEvent(idx, { form_type: e.target.value })} placeholder="941" className="border rounded px-2 py-1 text-sm" />
              <input value={ev.issued_on} onChange={e => updateEvent(idx, { issued_on: e.target.value })} placeholder="08-29-2022" className="border rounded px-2 py-1 text-sm font-mono text-xs" />
              <input value={ev.amount} onChange={e => updateEvent(idx, { amount: e.target.value })} placeholder="35449.33" type="number" step="0.01" className="border rounded px-2 py-1 text-sm" />
              <button type="button" onClick={() => removeEvent(idx)} disabled={events.length === 1} className="text-xs text-red-600 hover:text-red-800 disabled:opacity-30">remove</button>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => setEvents(prev => [...prev, blankEvent()])} className="mt-3 text-sm text-blue-700 hover:text-blue-900 font-medium">+ Add another quarter</button>
        <p className="text-xs text-gray-500 mt-2 italic">Columns: tax_quarter (e.g., 2021-Q3) · period_ending (mm-dd-yyyy) · form (941) · issued_on (mm-dd-yyyy) · amount</p>
      </section>

      {/* 3. Optional Mercury invoice */}
      <section className="bg-white border rounded-lg p-5">
        <h2 className="text-base font-bold text-gray-900 mb-3">3. Mercury invoice <span className="text-xs font-normal text-gray-500">(optional — fill in after firing the invoice)</span></h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <input value={invoiceNum} onChange={e => setInvoiceNum(e.target.value)} placeholder="Invoice # (e.g., MNT-MENTO-ERC-20260515-01)" className="border rounded px-2 py-1.5 text-sm" />
          <input value={invoiceAmount} onChange={e => setInvoiceAmount(e.target.value)} placeholder="Amount (1479.00)" type="number" step="0.01" className="border rounded px-2 py-1.5 text-sm" />
          <input value={invoicePayUrl} onChange={e => setInvoicePayUrl(e.target.value)} placeholder="Pay URL (https://app.mercury.com/pay/...)" className="border rounded px-2 py-1.5 text-sm" />
        </div>
      </section>

      {/* 4. Optional kickoff email */}
      <section className="bg-white border rounded-lg p-5">
        <h2 className="text-base font-bold text-gray-900 mb-3">4. Kickoff email <span className="text-xs font-normal text-gray-500">(optional — fires the branded &quot;$X recoverable, here&apos;s your status page&quot; email)</span></h2>
        <label className="flex items-center gap-2 text-sm mb-3">
          <input type="checkbox" checked={sendKickoff} onChange={e => setSendKickoff(e.target.checked)} />
          Send kickoff email now
        </label>
        {sendKickoff && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <input value={kickoffEmail} onChange={e => setKickoffEmail(e.target.value)} placeholder="Recipient email" type="email" className="border rounded px-2 py-1.5 text-sm" />
            <input value={kickoffName} onChange={e => setKickoffName(e.target.value)} placeholder="Recipient name (for salutation)" className="border rounded px-2 py-1.5 text-sm" />
          </div>
        )}
      </section>

      {/* 5. Token override */}
      <section className="bg-white border rounded-lg p-5">
        <h2 className="text-base font-bold text-gray-900 mb-3">5. Tracking token <span className="text-xs font-normal text-gray-500">(optional — auto-slugified from entity name if left blank)</span></h2>
        <input value={tokenOverride} onChange={e => setTokenOverride(e.target.value)} placeholder="e.g., 'mento-recovery' (leaves URL /erc-status/mento-recovery)" className="w-full border rounded px-2 py-1.5 text-sm font-mono" />
      </section>

      {error && <div className="bg-red-50 border border-red-200 text-red-800 text-sm p-3 rounded">{error}</div>}

      <button
        type="submit"
        disabled={submitting || !selectedEntity}
        className="w-full px-4 py-3 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded disabled:opacity-50"
      >
        {submitting ? 'Creating engagement…' : 'Create engagement'}
      </button>
    </form>
  );
}
