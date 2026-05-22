'use client';

/**
 * Compact "on the clock" widget for the expert dashboard. Two manual
 * buttons that mirror the two activities the system can't auto-detect:
 *
 *  - IRS direct dial (expert called PPS themselves, not via Bland)
 *  - Manual misc (anything else worth logging)
 *
 * Auto-instrumented kinds (sor_upload, bland_call, retell_call) DON'T
 * need a button — they self-open from the API/webhook calls and self-
 * close via the idle-cleanup cron. The widget surfaces any currently-
 * open session of any kind so the expert knows what the system thinks
 * they're doing.
 */

import { useState, useEffect, useCallback } from 'react';

interface OpenSession {
  id: string;
  kind: string;
  start_at: string;
  attributed_entity_ids: string[] | null;
  notes: string | null;
}

const KIND_LABEL: Record<string, string> = {
  manual: 'Manual',
  bland_call: 'Bland call',
  retell_call: 'Retell call',
  sor_upload: 'SOR uploads',
  irs_direct_dial: 'IRS direct dial',
};

export function ExpertTimeTrackerWidget() {
  const [open, setOpen] = useState<OpenSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/expert/time-log/open-sessions', { cache: 'no-store' });
      if (!res.ok) { setError(`status ${res.status}`); return; }
      const data = await res.json();
      setOpen(data.sessions || []);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'fetch failed');
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  const fire = useCallback(async (action: 'start' | 'stop', kind: 'irs_direct_dial' | 'manual') => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/expert/time-log/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, kind, notes: action === 'start' ? `${KIND_LABEL[kind]} session opened from dashboard` : undefined }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || `status ${res.status}`);
        return;
      }
      await refresh();
    } catch (err: any) {
      setError(err?.message || 'request failed');
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  const sessionFor = (kind: string) => open.find(s => s.kind === kind);

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          ⏱️ Time Tracker
          {open.length > 0 && (
            <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
              <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
              On the clock ({open.length} session{open.length === 1 ? '' : 's'})
            </span>
          )}
        </h3>
      </div>

      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-2">⚠ {error}</div>}

      {/* Currently-open sessions list */}
      {open.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {open.map(s => {
            const minsOpen = Math.round((Date.now() - new Date(s.start_at).getTime()) / 60_000);
            return (
              <div key={s.id} className="flex items-center justify-between text-xs bg-emerald-50 border border-emerald-200 rounded px-2.5 py-1.5">
                <div>
                  <span className="font-semibold text-emerald-900">{KIND_LABEL[s.kind] || s.kind}</span>
                  <span className="text-emerald-700 ml-2">{minsOpen} min</span>
                  {(s.attributed_entity_ids || []).length > 0 && (
                    <span className="text-emerald-600 ml-2">· {s.attributed_entity_ids!.length} entit{s.attributed_entity_ids!.length === 1 ? 'y' : 'ies'}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Manual controls */}
      <div className="grid grid-cols-2 gap-2">
        {(['irs_direct_dial', 'manual'] as const).map(kind => {
          const isOpen = !!sessionFor(kind);
          return (
            <button
              key={kind}
              disabled={loading}
              onClick={() => fire(isOpen ? 'stop' : 'start', kind)}
              className={`text-xs font-semibold px-3 py-2 rounded border transition-colors ${
                isOpen
                  ? 'bg-red-600 hover:bg-red-700 border-red-700 text-white'
                  : 'bg-white hover:bg-gray-50 border-gray-300 text-gray-900'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {isOpen ? `⏹ Stop ${KIND_LABEL[kind]}` : `▶ Start ${KIND_LABEL[kind]}`}
            </button>
          );
        })}
      </div>

      <p className="text-xs text-gray-500 mt-2">
        SOR uploads + Bland calls auto-open + close. Use the buttons above only when calling IRS directly (no Bland) or for manual sessions.
      </p>
    </div>
  );
}
