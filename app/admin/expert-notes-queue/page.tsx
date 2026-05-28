'use client';

/**
 * Admin "Expert Notes Queue" page.
 *
 * Replaces the auto-email-to-processor channel for expert notes. Every
 * expert-authored note across the portal lands here for admin review.
 * Read-only — no forward action, no delete, no send. Processors never
 * see expert notes (no email, no portal-thread visibility); admin uses
 * this surface to monitor.
 *
 * Driver: 2026-05-28 Matt — "No expert to processor communication
 * allowed in the system. There should just be a queue in the admin
 * portal for this communications."
 *
 * Layout: dense reverse-chronological list. Each row has entity + loan +
 * client + form context, the expert's name + kind tag + timestamp, and
 * the full body. Click the entity name to jump to the entity record in
 * /admin/requests/[id]#entity-{id}.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';

interface QueueNote {
  id: string;
  created_at: string;
  author_id: string | null;
  author_name: string | null;
  kind: string;
  body: string;
  entity_id: string;
  entity_name: string | null;
  entity_form_type: string | null;
  entity_status: string | null;
  entity_tid: string | null;
  entity_tid_kind: string | null;
  request_id: string | null;
  loan_number: string | null;
  client_id: string | null;
  client_name: string | null;
  client_slug: string | null;
}

const KIND_LABELS: Record<string, { label: string; color: string }> = {
  note:          { label: 'Note',          color: 'bg-gray-100 text-gray-700' },
  instruction:   { label: 'Instruction',   color: 'bg-blue-100 text-blue-700' },
  status_update: { label: 'Status update', color: 'bg-emerald-100 text-emerald-700' },
  question:      { label: 'Question',      color: 'bg-amber-100 text-amber-800' },
  answer:        { label: 'Answer',        color: 'bg-purple-100 text-purple-700' },
};

function fmtTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const ageMs = now - d.getTime();
  const ageMin = Math.floor(ageMs / 60000);
  if (ageMin < 1) return 'just now';
  if (ageMin < 60) return `${ageMin}m ago`;
  if (ageMin < 60 * 24) return `${Math.floor(ageMin / 60)}h ago`;
  if (ageMin < 60 * 24 * 7) return `${Math.floor(ageMin / (60 * 24))}d ago`;
  return d.toLocaleDateString();
}

export default function ExpertNotesQueuePage() {
  const [notes, setNotes] = useState<QueueNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<string>('');
  const [clientFilter, setClientFilter] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  // Gate the page client-side too — server route enforces admin but
  // this avoids a blank screen for non-admins who land on the URL.
  useEffect(() => {
    (async () => {
      const sb = createClient();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) { setError('Not signed in.'); setAuthChecked(true); return; }
      const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
      if (profile?.role !== 'admin') {
        setError('Admin access required.');
        setAuthChecked(true);
        return;
      }
      setAuthChecked(true);
    })();
  }, []);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', '200');
      if (kindFilter) params.set('kind', kindFilter);
      if (clientFilter) params.set('client_id', clientFilter);
      const res = await fetch(`/api/admin/expert-notes-queue?${params.toString()}`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to load queue');
        return;
      }
      setNotes(data.notes || []);
    } catch (err: any) {
      setError(err?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!authChecked || error) return;
    refresh();
  }, [authChecked, kindFilter, clientFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derive client filter options from current note set.
  const clientOptions = useMemo(() => {
    const map = new Map<string, string>();
    (notes || []).forEach((n) => {
      if (n.client_id && n.client_name) map.set(n.client_id, n.client_name);
    });
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [notes]);

  if (!authChecked) {
    return <div className="p-8 text-gray-500">Loading…</div>;
  }
  if (error && !notes) {
    return <div className="p-8 text-red-600">{error}</div>;
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-2xl font-bold text-mt-dark">Expert Notes Queue</h1>
          <p className="text-sm text-gray-500 mt-1">
            Every expert-authored note across the portal. Read-only — processors do not see expert
            notes by email or in the entity thread. Use this surface to monitor expert activity and
            decide if any of it needs to be relayed manually.
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="px-4 py-2 text-sm font-medium bg-mt-green text-white rounded-lg hover:bg-opacity-90 disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="mt-4 flex items-center gap-3 flex-wrap">
        <div>
          <label className="text-xs text-gray-500 mr-2">Kind:</label>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            className="px-2 py-1 text-sm border border-gray-300 rounded"
          >
            <option value="">All</option>
            {Object.entries(KIND_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-500 mr-2">Client:</label>
          <select
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            className="px-2 py-1 text-sm border border-gray-300 rounded"
          >
            <option value="">All</option>
            {clientOptions.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        </div>
        <span className="text-xs text-gray-400 ml-auto">
          {notes ? `${notes.length} note${notes.length === 1 ? '' : 's'}` : ''}
        </span>
      </div>

      {error && notes && (
        <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>
      )}

      <div className="mt-4 space-y-3">
        {notes && notes.length === 0 && (
          <div className="p-8 text-center text-gray-400 border border-dashed border-gray-200 rounded-lg">
            No expert notes match these filters.
          </div>
        )}
        {(notes || []).map((n) => {
          const kindMeta = KIND_LABELS[n.kind] || { label: n.kind, color: 'bg-gray-100 text-gray-700' };
          const entityHref = n.request_id ? `/admin/requests/${n.request_id}#entity-${n.entity_id}` : '#';
          return (
            <div key={n.id} className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${kindMeta.color}`}>
                      {kindMeta.label}
                    </span>
                    <Link href={entityHref} className="text-sm font-semibold text-mt-dark hover:underline truncate">
                      {n.entity_name || '(unknown entity)'}
                    </Link>
                    {n.loan_number && (
                      <span className="text-xs text-gray-500 font-mono">loan {n.loan_number}</span>
                    )}
                    {n.entity_form_type && (
                      <span className="text-xs text-gray-500">{n.entity_form_type}</span>
                    )}
                    {n.entity_status && (
                      <span className="text-[11px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded">
                        {n.entity_status}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {n.client_name && <span className="font-medium">{n.client_name}</span>}
                    {n.author_name && <span> · {n.author_name}</span>}
                    {' · '}
                    <span title={new Date(n.created_at).toLocaleString()}>{fmtTimestamp(n.created_at)}</span>
                  </div>
                </div>
              </div>
              <p className="mt-3 text-sm text-gray-800 whitespace-pre-wrap leading-snug">{n.body}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
