'use client';

/**
 * Per-entity admin <-> expert ops thread. Replaces email back-and-forth
 * for IRS-call instructions ("J&J: ROA 1120S, 2023-2026, request 941
 * Q1-Q4 2025") and status updates ("got busy signal, retrying 6 PM
 * EST"). Mounted on:
 *   - /admin/requests/[id]  (admin side, every entity card)
 *   - /expert dashboard      (expert side, every assignment card)
 *
 * On submit fires POST /api/entity-notes/[entityId] which inserts the
 * note + sends an email notification to the opposite party.
 *
 * Built 2026-05-26 from Joel Abernathy's feedback.
 */

import { useEffect, useState, useCallback } from 'react';

interface Note {
  id: string;
  author_id: string;
  author_role: 'admin' | 'expert';
  author_name: string;
  body: string;
  kind: 'note' | 'instruction' | 'status_update' | 'question' | 'answer';
  created_at: string;
}

interface Props {
  entityId: string;
  /** Set true to show the post-a-note form; false for read-only. */
  canPost?: boolean;
  /** "admin" or "expert" — drives the default kind on new posts. */
  viewerRole?: 'admin' | 'expert';
}

const KIND_OPTIONS: { value: Note['kind']; label: string }[] = [
  { value: 'note',          label: 'Note' },
  { value: 'instruction',   label: 'Instruction (admin → expert)' },
  { value: 'status_update', label: 'Status update' },
  { value: 'question',      label: 'Question' },
  { value: 'answer',        label: 'Answer' },
];

const KIND_BADGE: Record<Note['kind'], string> = {
  note:          'bg-gray-100 text-gray-700',
  instruction:   'bg-amber-100 text-amber-900',
  status_update: 'bg-blue-100 text-blue-900',
  question:      'bg-violet-100 text-violet-900',
  answer:        'bg-emerald-100 text-emerald-900',
};

const ROLE_BADGE: Record<Note['author_role'], string> = {
  admin:  'bg-indigo-100 text-indigo-900',
  expert: 'bg-emerald-100 text-emerald-900',
};

export function EntityNotesThread({ entityId, canPost = true, viewerRole = 'admin' }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [migrationPending, setMigrationPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<Note['kind']>(viewerRole === 'admin' ? 'instruction' : 'status_update');
  const [submitting, setSubmitting] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // Per-client instruction template — only fetched for admin viewers (experts
  // don't apply templates, they reply in their own framing). The button only
  // shows when the client has a template AND the body is empty (so we don't
  // clobber in-progress drafts).
  const [template, setTemplate] = useState<{ body: string; clientName: string; key: string } | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/entity-notes/${entityId}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setError(data.error || `HTTP ${res.status}`); return; }
      setNotes(data.notes || []);
      setMigrationPending(!!data.migration_pending);
    } catch (err: any) { setError(err?.message || 'Network error'); }
    finally { setLoading(false); }
  }, [entityId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Admin-only: fetch per-client template on mount so the "Apply default"
  // button can show without a runtime click delay.
  useEffect(() => {
    if (viewerRole !== 'admin' || !canPost) return;
    fetch(`/api/entity-notes/${entityId}/template`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d?.template && d?.client_name) {
          setTemplate({ body: d.template, clientName: d.client_name, key: d.resolved_key || 'default' });
        }
      })
      .catch(() => {/* silent — template is a nice-to-have */});
  }, [entityId, viewerRole, canPost]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setSubmitting(true); setError(null);
    try {
      const res = await fetch(`/api/entity-notes/${entityId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: body.trim(), kind }),
      });
      const text = await res.text();
      let data: any = null;
      try { data = JSON.parse(text); } catch {
        setError(`Server returned non-JSON (HTTP ${res.status}). Likely the entity_notes table isn't migrated yet.`);
        return;
      }
      if (!res.ok) {
        if (data?.migration_pending) {
          setMigrationPending(true);
          setError('Migration pending — paste supabase/migration-entity-notes.sql into Supabase Studio.');
        } else {
          setError(data?.error || `HTTP ${res.status}`);
        }
        return;
      }
      setBody('');
      await refresh();
    } catch (err: any) { setError(err?.message || 'Network error'); }
    finally { setSubmitting(false); }
  };

  if (loading) {
    return <div className="text-xs text-gray-400 mt-2">Loading notes…</div>;
  }

  if (migrationPending && notes.length === 0) {
    return (
      <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
        💬 Notes thread is built but the database migration hasn&apos;t been applied yet.
        Paste <code className="font-mono">supabase/migration-entity-notes.sql</code> into Supabase Studio to enable.
      </div>
    );
  }

  return (
    <div className="mt-3 border-t border-gray-200 pt-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-gray-700">
          💬 Notes <span className="text-gray-400 font-normal">({notes.length})</span>
        </h4>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="text-[11px] text-gray-500 hover:text-gray-800"
        >
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>

      {!collapsed && (
        <>
          {notes.length === 0 ? (
            <p className="text-xs text-gray-400 italic mb-2">No notes yet. {canPost && 'Be the first.'}</p>
          ) : (
            <div className="space-y-2 mb-3 max-h-96 overflow-y-auto">
              {notes.map((n) => (
                <div key={n.id} className="bg-white border border-gray-200 rounded px-3 py-2 text-xs">
                  <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${ROLE_BADGE[n.author_role]}`}>
                      {n.author_role}
                    </span>
                    <span className="font-medium text-gray-900">{n.author_name}</span>
                    {n.kind !== 'note' && (
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${KIND_BADGE[n.kind]}`}>
                        {n.kind.replace('_', ' ')}
                      </span>
                    )}
                    <span className="text-[10px] text-gray-400 ml-auto">
                      {new Date(n.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                  </div>
                  <p className="text-gray-800 whitespace-pre-wrap">{n.body}</p>
                </div>
              ))}
            </div>
          )}

          {canPost && (
            <form onSubmit={submit} className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as Note['kind'])}
                  disabled={submitting}
                  className="text-xs px-2 py-1 border border-gray-300 rounded bg-white"
                >
                  {KIND_OPTIONS.map((k) => (
                    <option key={k.value} value={k.value}>{k.label}</option>
                  ))}
                </select>
                {template && body.trim().length === 0 && (
                  <button
                    type="button"
                    onClick={() => { setBody(template.body); setKind('instruction'); }}
                    disabled={submitting}
                    className="text-xs px-2 py-1 bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-900 rounded font-medium disabled:opacity-50"
                    title={`Pre-fills with ${template.clientName}'s standard ${template.key} instruction template`}
                  >
                    📋 Apply {template.clientName} default
                  </button>
                )}
              </div>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={submitting}
                placeholder={viewerRole === 'admin'
                  ? 'Add an instruction or note for the assigned expert…'
                  : 'Add a status update or question for the admin…'}
                rows={3}
                maxLength={4000}
                className="w-full text-xs px-2 py-1.5 border border-gray-300 rounded resize-y disabled:opacity-50"
              />
              {error && (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-1.5">{error}</div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-gray-400">{body.length}/4000 · sends email to the {viewerRole === 'admin' ? 'expert' : 'admin team'} on post</span>
                <button
                  type="submit"
                  disabled={submitting || !body.trim()}
                  className="px-3 py-1 text-xs font-semibold bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                >
                  {submitting ? 'Posting…' : 'Post note'}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}
