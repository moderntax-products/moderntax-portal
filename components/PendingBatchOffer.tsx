'use client';

/**
 * PendingBatchOffer — top-of-dashboard card on /expert.
 *
 * Two states (driven by batch.status from /api/expert/batch/pending):
 *
 *   1. pending_acceptance
 *      Big amber card with:
 *        · Title: "New batch offered — N entities"
 *        · Live countdown to acceptance_deadline (30-min window)
 *        · List of entities (client / loan / entity_name)
 *        · Accept button (triggers 8821 regen for all entities)
 *        · Decline button (optional reason input)
 *
 *   2. accepted
 *      Smaller green card with:
 *        · "Active batch — completion due in {countdown to completion_deadline}"
 *        · Number of entities (links back to assignments below)
 *
 * Polls /api/expert/batch/pending every 30s so a freshly-offered batch
 * appears without a manual refresh.
 */

import { useEffect, useState, useCallback } from 'react';

interface BatchEntity {
  assignmentId: string;
  assignmentStatus: string;
  entityId: string;
  entityName: string;
  tidKind: string;
  formType: string;
  years: string[];
  loanNumber: string | null;
  clientName: string | null;
}

interface Batch {
  id: string;
  status: 'pending_acceptance' | 'accepted' | 'declined' | 'expired' | 'completed' | 'cancelled';
  offered_at: string;
  acceptance_deadline: string;
  accepted_at: string | null;
  completion_deadline: string | null;
  notes: string | null;
}

function useCountdown(deadlineIso: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!deadlineIso) return null;
  const remaining = new Date(deadlineIso).getTime() - now;
  if (remaining <= 0) return 'expired';
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function PendingBatchOffer() {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [entities, setEntities] = useState<BatchEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<'accept' | 'decline' | null>(null);
  const [showDeclineForm, setShowDeclineForm] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const fetchBatch = useCallback(async () => {
    try {
      const res = await fetch('/api/expert/batch/pending');
      if (!res.ok) {
        setBatch(null);
        setEntities([]);
        return;
      }
      const data = await res.json();
      setBatch(data.batch || null);
      setEntities(data.entities || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBatch();
    const t = setInterval(fetchBatch, 30_000); // poll every 30s
    return () => clearInterval(t);
  }, [fetchBatch]);

  const acceptanceCountdown = useCountdown(batch?.status === 'pending_acceptance' ? batch.acceptance_deadline : null);
  const completionCountdown = useCountdown(batch?.status === 'accepted' ? batch?.completion_deadline || null : null);

  const handleAccept = async () => {
    if (!batch) return;
    setSubmitting('accept');
    setError(null);
    try {
      const res = await fetch(`/api/expert/batch/${batch.id}/accept`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to accept');
        return;
      }
      // Reload to surface the new assignments below
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSubmitting(null);
    }
  };

  const handleDecline = async () => {
    if (!batch) return;
    setSubmitting('decline');
    setError(null);
    try {
      const res = await fetch(`/api/expert/batch/${batch.id}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: declineReason }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to decline');
        return;
      }
      setBatch(null);
      setEntities([]);
      setShowDeclineForm(false);
      setDeclineReason('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSubmitting(null);
    }
  };

  if (loading || !batch) return null;

  // ─── State 1: pending_acceptance — big amber offer card ─────────────────
  if (batch.status === 'pending_acceptance') {
    const expired = acceptanceCountdown === 'expired';
    return (
      <div className={`rounded-lg border-2 p-6 mb-6 shadow-sm ${expired ? 'bg-gray-50 border-gray-300' : 'bg-amber-50 border-amber-400'}`}>
        <div className="flex justify-between items-start mb-4">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-amber-800 mb-1">
              {expired ? 'Offer Expired' : 'New Batch Offered'}
            </div>
            <h2 className="text-2xl font-bold text-gray-900">
              {entities.length} {entities.length === 1 ? 'entity' : 'entities'} ready for IRS work
            </h2>
            {batch.notes && <p className="text-sm text-gray-700 mt-1">{batch.notes}</p>}
          </div>
          <div className="text-right">
            <div className="text-xs font-bold uppercase tracking-wider text-amber-800 mb-1">
              {expired ? 'Expired' : 'Accept Within'}
            </div>
            <div className={`text-3xl font-mono font-bold ${expired ? 'text-gray-400' : acceptanceCountdown && Number(acceptanceCountdown.split(':')[0]) < 5 ? 'text-red-700' : 'text-amber-900'}`}>
              {acceptanceCountdown || '--:--'}
            </div>
          </div>
        </div>

        <div className="bg-white rounded border border-gray-200 mb-4 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-600">
              <tr>
                <th className="text-left px-4 py-2">Entity</th>
                <th className="text-left px-4 py-2">Client</th>
                <th className="text-left px-4 py-2">Form</th>
                <th className="text-left px-4 py-2">Years</th>
                <th className="text-left px-4 py-2">Loan</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {entities.map(e => (
                <tr key={e.entityId}>
                  <td className="px-4 py-2 font-medium">{e.entityName}</td>
                  <td className="px-4 py-2 text-gray-600">{e.clientName}</td>
                  <td className="px-4 py-2 font-mono text-xs">{e.formType}</td>
                  <td className="px-4 py-2 font-mono text-xs">{Array.isArray(e.years) ? e.years.join(', ') : '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-500">{e.loanNumber || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-amber-800 mb-4 italic">
          On accept: 8821 PDFs will be regenerated with your CAF/PTIN/phone and attached to each assignment. You&apos;ll then have <strong>24 hours</strong> to complete the batch.
        </p>

        {error && <div className="bg-red-50 border border-red-200 text-red-800 text-sm p-3 rounded mb-3">{error}</div>}

        {!expired && !showDeclineForm && (
          <div className="flex gap-3">
            <button
              onClick={handleAccept}
              disabled={submitting !== null}
              className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-semibold rounded-md text-sm"
            >
              {submitting === 'accept' ? 'Accepting…' : `Accept ${entities.length} ${entities.length === 1 ? 'entity' : 'entities'}`}
            </button>
            <button
              onClick={() => setShowDeclineForm(true)}
              disabled={submitting !== null}
              className="px-5 py-2.5 bg-white hover:bg-gray-50 disabled:opacity-50 text-gray-700 font-medium border border-gray-300 rounded-md text-sm"
            >
              Decline
            </button>
          </div>
        )}

        {showDeclineForm && (
          <div className="bg-white border border-gray-200 rounded p-3">
            <label className="block text-xs font-medium text-gray-700 mb-1">Reason for declining (optional)</label>
            <textarea
              value={declineReason}
              onChange={e => setDeclineReason(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="e.g. wrong form type, conflict of interest, capacity"
              className="w-full text-sm border border-gray-300 rounded p-2 mb-2"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setShowDeclineForm(false); setDeclineReason(''); }}
                disabled={submitting !== null}
                className="px-3 py-1.5 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDecline}
                disabled={submitting !== null}
                className="px-3 py-1.5 text-sm font-semibold text-white bg-red-600 rounded hover:bg-red-700 disabled:opacity-50"
              >
                {submitting === 'decline' ? 'Declining…' : 'Confirm Decline'}
              </button>
            </div>
          </div>
        )}

        {expired && (
          <div className="text-sm text-gray-600">
            Acceptance window passed. The cron will release these entities back to the pool shortly.
          </div>
        )}
      </div>
    );
  }

  // ─── State 2: accepted — small green active card ─────────────────────────
  if (batch.status === 'accepted') {
    const overdue = completionCountdown === 'expired';
    return (
      <div className={`rounded-lg border p-4 mb-6 ${overdue ? 'bg-red-50 border-red-300' : 'bg-emerald-50 border-emerald-300'}`}>
        <div className="flex justify-between items-center">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-emerald-800 mb-0.5">
              {overdue ? 'Batch overdue' : 'Active batch'}
            </div>
            <div className="text-sm text-gray-900">
              <strong>{entities.length}</strong> {entities.length === 1 ? 'entity' : 'entities'} accepted · finish by{' '}
              <span className={`font-mono font-bold ${overdue ? 'text-red-800' : 'text-emerald-900'}`}>
                {completionCountdown}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
