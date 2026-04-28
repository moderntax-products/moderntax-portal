'use client';

/**
 * StatusPageClient — public-facing real-time status display.
 *
 * Three things only:
 *   1. System status banner (green/amber/red derived from current wait)
 *   2. Big "current wait time" number (real-time, refreshed every 15s)
 *   3. Lifetime average hold time (across every completed call ever)
 *   4. Single "last call" card with its hold + duration
 *
 * No 7d aggregates, no recent-calls table, no live activity grid —
 * those will come back once we scale and the data tells a richer
 * story. For now: customers want to know "should I expect my pull
 * to be quick today?" and that's the entire job.
 */

import { useEffect, useState } from 'react';

interface StatusPayload {
  updated_at: string;
  current_wait_minutes: number | null;
  lifetime_avg_hold_minutes: number | null;
  lifetime_calls_completed: number;
  last_call: {
    ended_at: string;
    hold_minutes: number | null;
    duration_minutes: number | null;
    status: string;
    entities: number;
  } | null;
}

interface Props {
  initial: StatusPayload | null;
}

const POLL_MS = 15_000; // matches API edge cache for true real-time feel

export function StatusPageClient({ initial }: Props) {
  const [status, setStatus] = useState<StatusPayload | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date>(new Date());

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/public/status', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as StatusPayload;
        if (!cancelled) {
          setStatus(data);
          setLastFetched(new Date());
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'fetch failed');
      }
    };
    const interval = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const health = computeHealth(status);
  const healthBg =
    health.level === 'green' ? 'bg-emerald-500'
    : health.level === 'amber' ? 'bg-amber-500'
    : 'bg-red-500';
  const healthBgSubtle =
    health.level === 'green' ? 'bg-emerald-50 border-emerald-200'
    : health.level === 'amber' ? 'bg-amber-50 border-amber-200'
    : 'bg-red-50 border-red-200';
  const healthText =
    health.level === 'green' ? 'text-emerald-900'
    : health.level === 'amber' ? 'text-amber-900'
    : 'text-red-900';

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest text-gray-500 mb-1">ModernTax</p>
            <h1 className="text-2xl font-bold text-mt-dark">IRS Pull Status</h1>
          </div>
          <a href="https://portal.moderntax.io" className="text-sm text-mt-green font-semibold hover:underline">
            Portal sign-in →
          </a>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">

        {/* System status banner */}
        <div className={`rounded-xl border-2 ${healthBgSubtle} p-6`}>
          <div className="flex items-start gap-4">
            <div className="relative flex-shrink-0 mt-1">
              <span className={`block w-4 h-4 rounded-full ${healthBg}`} />
              <span className={`absolute top-0 left-0 w-4 h-4 rounded-full ${healthBg} animate-ping opacity-75`} />
            </div>
            <div className="flex-1">
              <h2 className={`text-xl font-bold ${healthText}`}>{health.headline}</h2>
              <p className={`text-sm ${healthText} opacity-90 mt-1`}>{health.description}</p>
            </div>
          </div>
        </div>

        {!status && (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center text-gray-500">
            Status data temporarily unavailable. Refreshing every 15 seconds.
          </div>
        )}

        {status && (
          <>
            {/* CURRENT WAIT — hero metric */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-center">
              <p className="text-xs uppercase tracking-widest text-gray-500 font-bold">Current IRS hold time</p>
              <p className="text-6xl font-bold text-mt-dark mt-3 font-mono">
                {fmtBigDuration(status.current_wait_minutes)}
              </p>
              <p className="text-sm text-gray-600 mt-3">
                {status.current_wait_minutes === null
                  ? 'No calls currently on hold with the IRS — pulls completing without delay.'
                  : 'Live — longest current wait being experienced right now by an active call.'}
              </p>
            </div>

            {/* Lifetime avg hold */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-baseline justify-between">
                <p className="text-xs uppercase tracking-widest text-gray-500 font-bold">Average hold time (all-time)</p>
                <p className="text-xs text-gray-400">across {status.lifetime_calls_completed.toLocaleString()} completed call{status.lifetime_calls_completed === 1 ? '' : 's'}</p>
              </div>
              <p className="text-3xl font-bold text-mt-dark mt-2 font-mono">
                {fmtMinutes(status.lifetime_avg_hold_minutes)}
              </p>
            </div>

            {/* Last call */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <p className="text-xs uppercase tracking-widest text-gray-500 font-bold mb-3">Most recent call</p>
              {!status.last_call ? (
                <p className="text-sm text-gray-500">No completed calls yet.</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-gray-500">Ended</p>
                    <p className="text-sm font-semibold text-mt-dark mt-0.5">{fmtRelative(status.last_call.ended_at)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-gray-500">Status</p>
                    <p className="mt-0.5">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[11px] font-bold uppercase ${
                          status.last_call.status === 'completed' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                        }`}
                      >
                        {status.last_call.status}
                      </span>
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-gray-500">Hold time</p>
                    <p className="text-sm font-semibold text-mt-dark mt-0.5 font-mono">{fmtMinutes(status.last_call.hold_minutes)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-gray-500">Entities</p>
                    <p className="text-sm font-semibold text-mt-dark mt-0.5">{status.last_call.entities}</p>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* Footer */}
        <div className="text-xs text-gray-500 text-center pt-4">
          {status && (
            <>
              Updated {fmtRelative(status.updated_at)} · auto-refresh every 15s
              {error && <span className="text-amber-600 ml-2">· last refresh failed: {error}</span>}
            </>
          )}
          <p className="mt-2">
            Local clock: {lastFetched.toLocaleTimeString()} · Powered by ModernTax IRS PPS automation
          </p>
        </div>
      </div>
    </div>
  );
}

// ───────── helpers ─────────

function fmtMinutes(m: number | null): string {
  if (m === null || m === undefined) return '—';
  if (m < 1) return '< 1 min';
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60);
  const rest = Math.round(m % 60);
  return rest > 0 ? `${h}h ${rest}m` : `${h}h`;
}

// Hero number — always two-line if hours: "1h 24m". One-line otherwise.
function fmtBigDuration(m: number | null): string {
  if (m === null || m === undefined) return '0 min';
  if (m < 1) return '< 1 min';
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60);
  const rest = Math.round(m % 60);
  return rest > 0 ? `${h}h ${rest}m` : `${h}h`;
}

function fmtRelative(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function computeHealth(status: StatusPayload | null): { level: 'green' | 'amber' | 'red'; headline: string; description: string } {
  if (!status) {
    return { level: 'amber', headline: 'Checking system status…', description: 'Loading current IRS pull metrics.' };
  }
  // Health derived from current wait vs lifetime baseline.
  // No active wait OR wait at or below baseline → green.
  // 1.5x baseline → amber. 3x → red.
  const current = status.current_wait_minutes ?? 0;
  const baseline = status.lifetime_avg_hold_minutes ?? 30; // sensible fallback if no history yet
  const ratio = baseline > 0 ? current / baseline : 0;

  if (current === 0 || ratio < 1.0) {
    return {
      level: 'green',
      headline: 'IRS calls are flowing normally',
      description: status.current_wait_minutes === null
        ? 'No calls on hold right now. Submit a request and we typically have transcripts back within 24-48 hours.'
        : `Current hold (${fmtMinutes(current)}) is at or below the historical average (${fmtMinutes(baseline)}).`,
    };
  }
  if (ratio < 2.0) {
    return {
      level: 'amber',
      headline: 'Slower than usual',
      description: `Active hold time (${fmtMinutes(current)}) is running about ${Math.round(ratio * 100)}% of normal (${fmtMinutes(baseline)}). Pulls still completing — expect slightly longer turnaround.`,
    };
  }
  return {
    level: 'red',
    headline: 'IRS hold times significantly elevated',
    description: `Active hold time is ${Math.round(ratio * 100)}% of the historical average. Pulls in flight may take noticeably longer than usual today.`,
  };
}
