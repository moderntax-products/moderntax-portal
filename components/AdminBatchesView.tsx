'use client';

/**
 * Live admin batches dashboard. Polls /api/admin/batch/list every 30s.
 *
 * Sections:
 *   · Active (pending_acceptance + accepted) — live countdowns, cancel button
 *   · Recent terminal (last 7 days completed/declined/expired/cancelled)
 *
 * Filters by status. Cancel action posts to /api/admin/expert/batch/[id]/cancel.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

interface BatchEntity {
  assignmentId: string;
  assignmentStatus: string;
  entityId: string;
  entityName: string;
  entityStatus: string;
  formType: string;
  loanNumber: string | null;
  clientName: string | null;
}

interface BatchRow {
  id: string;
  status: 'pending_acceptance' | 'accepted' | 'declined' | 'expired' | 'completed' | 'cancelled';
  offeredAt: string;
  acceptanceDeadline: string;
  acceptedAt: string | null;
  declinedAt: string | null;
  expiredAt: string | null;
  cancelledAt: string | null;
  completionDeadline: string | null;
  completedAt: string | null;
  declineReason: string | null;
  notes: string | null;
  expert: { id: string; email: string; name: string | null } | null;
  offerer: { email: string; name: string | null } | null;
  entities: BatchEntity[];
}

const STATUS_COLORS: Record<BatchRow['status'], string> = {
  pending_acceptance: 'bg-amber-100 text-amber-900 border-amber-300',
  accepted:           'bg-emerald-100 text-emerald-900 border-emerald-300',
  completed:          'bg-blue-100 text-blue-900 border-blue-300',
  declined:           'bg-gray-100 text-gray-700 border-gray-300',
  expired:            'bg-gray-100 text-gray-700 border-gray-300',
  cancelled:          'bg-red-100 text-red-900 border-red-300',
};

const STATUS_LABEL: Record<BatchRow['status'], string> = {
  pending_acceptance: 'Pending Accept',
  accepted:           'In Progress',
  completed:          'Completed',
  declined:           'Declined',
  expired:            'Expired',
  cancelled:          'Cancelled',
};

function timeUntil(deadlineIso: string | null, serverTimeIso: string, nowMs: number) {
  if (!deadlineIso) return null;
  // Correct for client/server clock skew
  const skew = nowMs - new Date(serverTimeIso).getTime();
  const remaining = new Date(deadlineIso).getTime() - (Date.now() - skew);
  if (remaining <= 0) return { label: 'expired', overdue: true };
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  if (hours > 0) return { label: `${hours}h ${String(minutes).padStart(2,'0')}m`, overdue: false };
  return { label: `${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`, overdue: false };
}

export function AdminBatchesView({ initialBatches, initialServerTime }: { initialBatches: BatchRow[]; initialServerTime: string }) {
  const [batches, setBatches] = useState<BatchRow[]>(initialBatches);
  const [serverTime, setServerTime] = useState<string>(initialServerTime);
  const [nowMs, setNowMs] = useState<number>(Date.now());
  const [filter, setFilter] = useState<'active' | 'all' | 'terminal'>('active');
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const fetchBatches = useCallback(async () => {
    const res = await fetch('/api/admin/batch/list?limit=100');
    if (!res.ok) return;
    const data = await res.json();
    setBatches(data.batches || []);
    setServerTime(data.serverTime);
  }, []);

  // 30s refresh + 1s tick for countdowns
  useEffect(() => {
    const refresh = setInterval(fetchBatches, 30_000);
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => { clearInterval(refresh); clearInterval(tick); };
  }, [fetchBatches]);

  const filtered = batches.filter(b => {
    if (filter === 'active') return ['pending_acceptance', 'accepted'].includes(b.status);
    if (filter === 'terminal') return ['completed', 'declined', 'expired', 'cancelled'].includes(b.status);
    return true;
  });

  const counts = {
    pending: batches.filter(b => b.status === 'pending_acceptance').length,
    accepted: batches.filter(b => b.status === 'accepted').length,
    completed_today: batches.filter(b =>
      b.status === 'completed' && b.completedAt &&
      new Date(b.completedAt).getTime() > Date.now() - 86_400_000,
    ).length,
    overdue: batches.filter(b =>
      b.status === 'accepted' &&
      b.completionDeadline &&
      new Date(b.completionDeadline).getTime() < Date.now(),
    ).length,
  };

  const handleCancel = async (batchId: string) => {
    const reason = prompt('Reason for cancelling this batch? (will be visible to the expert)');
    if (reason === null) return; // user cancelled prompt
    setCancellingId(batchId);
    setCancelError(null);
    try {
      const res = await fetch(`/api/admin/expert/batch/${batchId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCancelError(data.error || 'Failed to cancel');
        return;
      }
      await fetchBatches();
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* KPI tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Pending Accept" value={counts.pending} color="amber" />
        <Kpi label="In Progress" value={counts.accepted} color="emerald" />
        <Kpi label="Completed (24h)" value={counts.completed_today} color="blue" />
        <Kpi label="Overdue" value={counts.overdue} color="red" />
      </div>

      {/* Filter pills + new-batch link */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {(['active', 'terminal', 'all'] as const).map(k => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition ${
                filter === k ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
              }`}
            >
              {k === 'active' ? 'Active' : k === 'terminal' ? 'Recent terminal' : 'All'}
            </button>
          ))}
        </div>
        <Link
          href="/admin/batches/new"
          className="px-3 py-1.5 text-xs font-semibold text-white bg-amber-600 rounded-md hover:bg-amber-700"
        >
          + Offer New Batch
        </Link>
      </div>

      {cancelError && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-sm p-3 rounded">{cancelError}</div>
      )}

      {/* Batch cards */}
      <div className="space-y-3">
        {filtered.length === 0 && (
          <div className="text-center py-10 text-sm text-gray-500 italic bg-white border border-gray-200 rounded-lg">
            No batches in this filter.
          </div>
        )}
        {filtered.map(b => {
          const accCountdown = b.status === 'pending_acceptance' ? timeUntil(b.acceptanceDeadline, serverTime, nowMs) : null;
          const completionCountdown = b.status === 'accepted' ? timeUntil(b.completionDeadline, serverTime, nowMs) : null;
          const isActive = ['pending_acceptance', 'accepted'].includes(b.status);

          return (
            <div key={b.id} className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
              <div className="flex justify-between items-start gap-3 mb-2">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded border ${STATUS_COLORS[b.status]}`}>
                      {STATUS_LABEL[b.status]}
                    </span>
                    <span className="text-xs text-gray-500">
                      to <strong>{b.expert?.name || b.expert?.email || '—'}</strong>
                    </span>
                    {b.offerer && (
                      <span className="text-xs text-gray-400">· offered by {b.offerer.name || b.offerer.email}</span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500">
                    {b.entities.length} {b.entities.length === 1 ? 'entity' : 'entities'} · offered {new Date(b.offeredAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    {b.notes && <> · <em>{b.notes}</em></>}
                  </div>
                </div>
                {(accCountdown || completionCountdown) && (
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-wide text-gray-500 font-bold">
                      {accCountdown ? 'Accept In' : 'Finish In'}
                    </div>
                    <div className={`text-xl font-mono font-bold ${(accCountdown?.overdue || completionCountdown?.overdue) ? 'text-red-700' : 'text-gray-900'}`}>
                      {(accCountdown || completionCountdown)?.label}
                    </div>
                  </div>
                )}
              </div>

              {/* Entities */}
              <div className="border-t border-gray-100 pt-2 mt-2">
                <div className="space-y-1">
                  {b.entities.map(e => (
                    <div key={e.entityId} className="flex justify-between text-xs">
                      <Link href={`/admin/requests/${e.entityId}`} className="text-gray-900 hover:text-blue-700">
                        <strong>{e.entityName}</strong>
                        <span className="text-gray-500 ml-1">({e.clientName} · {e.formType} · loan {e.loanNumber || '—'})</span>
                      </Link>
                      <span className="font-mono text-gray-500">{e.entityStatus}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Terminal state details */}
              {b.declineReason && (
                <div className="mt-2 text-xs text-gray-600 italic">Reason: {b.declineReason}</div>
              )}

              {/* Admin cancel button */}
              {isActive && (
                <div className="mt-2 flex justify-end">
                  <button
                    onClick={() => handleCancel(b.id)}
                    disabled={cancellingId === b.id}
                    className="text-xs font-medium text-red-700 hover:text-red-900 underline disabled:opacity-50"
                  >
                    {cancellingId === b.id ? 'Cancelling…' : 'Cancel batch (admin override)'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: number; color: 'amber' | 'emerald' | 'blue' | 'red' }) {
  const colorMap = {
    amber:   'bg-amber-50 border-amber-200 text-amber-900',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    blue:    'bg-blue-50 border-blue-200 text-blue-900',
    red:     value > 0 ? 'bg-red-50 border-red-300 text-red-900' : 'bg-gray-50 border-gray-200 text-gray-400',
  };
  return (
    <div className={`rounded-lg border p-3 ${colorMap[color]}`}>
      <div className="text-xs uppercase tracking-wide font-semibold">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}
