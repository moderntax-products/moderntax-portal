'use client';

/**
 * Admin form for offering a new batch to an expert.
 * Renders the eligible-entity pool + expert selector + Offer button.
 */

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';

interface PoolEntity {
  id: string;
  entityName: string;
  tidKind: string;
  formType: string;
  years: string[];
  waitingSinceIso: string;
  loanNumber: string | null;
  clientName: string | null;
}

interface ExpertOpt {
  id: string;
  email: string;
  fullName: string | null;
  credsComplete: boolean;
  missingFields: string[];
  currentBatchStatus: string | null; // 'pending_acceptance' | 'accepted' | null
}

interface Props {
  pool: PoolEntity[];
  experts: ExpertOpt[];
}

const MIN = 1;        // we allow 1+ but recommend 3
const MAX = 5;        // matches Matt's operational ceiling

function daysSince(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return '1d';
  return `${days}d`;
}

export function AdminBatchCreateForm({ pool, experts }: Props) {
  const router = useRouter();
  const [selectedEntities, setSelectedEntities] = useState<Set<string>>(new Set());
  const [selectedExpert, setSelectedExpert] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleEntity = (id: string) => {
    setSelectedEntities(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX) next.add(id);
      return next;
    });
  };

  const availableExperts = useMemo(
    () => experts.filter(e => e.credsComplete && !e.currentBatchStatus),
    [experts],
  );

  const handleSubmit = async () => {
    setError(null);
    if (selectedEntities.size < MIN) { setError(`Select at least ${MIN} entity`); return; }
    if (!selectedExpert) { setError('Pick an expert'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/expert/batch/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expertId: selectedExpert,
          entityIds: Array.from(selectedEntities),
          notes: notes || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to create batch');
        return;
      }
      router.push('/admin');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Entity pool */}
      <section className="bg-white border border-gray-200 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900">
            Eligible Entities ({pool.length} in pool)
          </h2>
          <span className="text-sm text-gray-600">
            {selectedEntities.size} / {MAX} selected
          </span>
        </div>
        {pool.length === 0 ? (
          <p className="text-sm text-gray-500 italic">
            No eligible entities — all 8821-signed entities are already assigned or completed.
          </p>
        ) : (
          <div className="overflow-hidden border border-gray-100 rounded">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-600">
                <tr>
                  <th className="w-10 px-3 py-2"></th>
                  <th className="text-left px-3 py-2">Entity</th>
                  <th className="text-left px-3 py-2">Client</th>
                  <th className="text-left px-3 py-2">Form</th>
                  <th className="text-left px-3 py-2">Years</th>
                  <th className="text-left px-3 py-2">Loan</th>
                  <th className="text-left px-3 py-2">Waiting</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {pool.map(e => {
                  const checked = selectedEntities.has(e.id);
                  const disabled = !checked && selectedEntities.size >= MAX;
                  return (
                    <tr key={e.id} className={checked ? 'bg-blue-50' : ''}>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleEntity(e.id)}
                          aria-label={`Select ${e.entityName}`}
                        />
                      </td>
                      <td className="px-3 py-2 font-medium">{e.entityName}</td>
                      <td className="px-3 py-2 text-gray-600">{e.clientName}</td>
                      <td className="px-3 py-2 font-mono text-xs">{e.formType}</td>
                      <td className="px-3 py-2 font-mono text-xs">{e.years.join(', ')}</td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-500">{e.loanNumber || '—'}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">{daysSince(e.waitingSinceIso)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Expert + notes */}
      <section className="bg-white border border-gray-200 rounded-lg p-6">
        <h2 className="text-lg font-bold text-gray-900 mb-4">Offer To</h2>
        <div className="mb-4">
          <label className="block text-xs font-medium text-gray-700 mb-1">Expert</label>
          <select
            value={selectedExpert}
            onChange={e => setSelectedExpert(e.target.value)}
            className="w-full text-sm border border-gray-300 rounded px-3 py-2"
          >
            <option value="">— pick an expert —</option>
            {experts.map(e => {
              const label = e.fullName || e.email;
              if (!e.credsComplete) {
                return <option key={e.id} value={e.id} disabled>{label} — ⚠ missing {e.missingFields.join('/')}</option>;
              }
              if (e.currentBatchStatus) {
                return <option key={e.id} value={e.id} disabled>{label} — busy ({e.currentBatchStatus})</option>;
              }
              return <option key={e.id} value={e.id}>{label}</option>;
            })}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            {availableExperts.length} of {experts.length} experts available (complete creds + no active batch).
          </p>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Notes for expert (optional)</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="e.g. high-priority Centerstone deals, please prioritize"
            className="w-full text-sm border border-gray-300 rounded px-3 py-2"
          />
        </div>
      </section>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-sm p-3 rounded">{error}</div>
      )}

      <div className="flex justify-end gap-2">
        <button
          onClick={() => router.back()}
          className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={submitting || selectedEntities.size < MIN || !selectedExpert}
          className="px-5 py-2 text-sm font-semibold text-white bg-emerald-600 rounded hover:bg-emerald-700 disabled:opacity-50"
        >
          {submitting ? 'Offering…' : `Offer ${selectedEntities.size} ${selectedEntities.size === 1 ? 'entity' : 'entities'}`}
        </button>
      </div>
    </div>
  );
}
