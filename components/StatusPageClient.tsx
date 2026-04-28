'use client';

/**
 * StatusPageClient — public-facing live status display.
 *
 * Polls /api/public/status every 60s for fresh data. Server-rendered
 * initial state means the page is useful even if JS is disabled (and
 * crawlable for "ModernTax IRS status" SEO).
 *
 * Three sections:
 *   - SYSTEM STATUS — green/amber/red indicator + headline metric
 *   - LIVE ACTIVITY — calls in flight, on hold, experts working
 *   - 7-DAY THROUGHPUT — entities delivered, calls completed, success rate
 *   - RECENT CALLS table (anonymized — no PII)
 */

import { useEffect, useState } from 'react';

interface StatusPayload {
  updated_at: string;
  live: { active_calls: number; calls_on_hold: number; experts_active: number };
  wait_times: {
    avg_hold_minutes_today: number | null;
    avg_hold_minutes_7d: number | null;
    median_hold_minutes_7d: number | null;
  };
  throughput: {
    entities_completed_today: number;
    entities_completed_7d: number;
    calls_completed_today: number;
    calls_completed_7d: number;
    success_rate_7d: number;
  };
  recent: { ended_at: string; duration_minutes: number | null; hold_minutes: number | null; status: string; entities: number }[];
}

interface Props {
  initial: StatusPayload | null;
}

const POLL_MS = 60_000;

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

  // Derive overall system health from wait times + success rate
  const health = computeHealth(status);
  const healthBg = health.level === 'green' ? 'bg-emerald-500' : health.level === 'amber' ? 'bg-amber-500' : 'bg-red-500';
  const healthBgSubtle = health.level === 'green' ? 'bg-emerald-50 border-emerald-200' : health.level === 'amber' ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200';
  const healthText = health.level === 'green' ? 'text-emerald-900' : health.level === 'amber' ? 'text-amber-900' : 'text-red-900';

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest text-gray-500 mb-1">ModernTax</p>
            <h1 className="text-2xl font-bold text-mt-dark">IRS Pull Status</h1>
          </div>
          <a href="https://portal.moderntax.io" className="text-sm text-mt-green font-semibold hover:underline">
            Portal sign-in →
          </a>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
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
            Status data temporarily unavailable. Refreshing every minute.
          </div>
        )}

        {status && (
          <>
            {/* Live Activity */}
            <section>
              <h3 className="text-xs uppercase tracking-widest font-bold text-gray-500 mb-3">Live activity</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat label="Calls in flight" value={status.live.active_calls} accent="blue" />
                <Stat label="On hold with IRS" value={status.live.calls_on_hold} accent="amber" />
                <Stat label="Experts working" value={status.live.experts_active} accent="emerald" />
                <Stat
                  label="Avg hold today"
                  value={fmtMinutes(status.wait_times.avg_hold_minutes_today)}
                  accent="purple"
                />
              </div>
            </section>

            {/* Throughput (7d) */}
            <section>
              <h3 className="text-xs uppercase tracking-widest font-bold text-gray-500 mb-3">Last 7 days</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat
                  label="Transcripts delivered"
                  value={status.throughput.entities_completed_7d.toLocaleString()}
                  accent="emerald"
                  sub={`${status.throughput.entities_completed_today} today`}
                />
                <Stat
                  label="IRS calls completed"
                  value={status.throughput.calls_completed_7d.toLocaleString()}
                  accent="blue"
                  sub={`${status.throughput.calls_completed_today} today`}
                />
                <Stat
                  label="Median hold time"
                  value={fmtMinutes(status.wait_times.median_hold_minutes_7d)}
                  accent="purple"
                />
                <Stat
                  label="Success rate"
                  value={`${Math.round(status.throughput.success_rate_7d * 100)}%`}
                  accent={status.throughput.success_rate_7d > 0.9 ? 'emerald' : status.throughput.success_rate_7d > 0.75 ? 'amber' : 'red'}
                  sub="completed / closed"
                />
              </div>
            </section>

            {/* Recent calls */}
            <section>
              <h3 className="text-xs uppercase tracking-widest font-bold text-gray-500 mb-3">Recent calls</h3>
              <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                {status.recent.length === 0 ? (
                  <p className="p-6 text-sm text-gray-500 text-center">No recent calls in the last day.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                      <tr>
                        <th className="text-left px-4 py-2.5">Ended</th>
                        <th className="text-left px-4 py-2.5">Status</th>
                        <th className="text-right px-4 py-2.5">Entities</th>
                        <th className="text-right px-4 py-2.5">Hold</th>
                        <th className="text-right px-4 py-2.5">Total duration</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {status.recent.map((r, i) => (
                        <tr key={i}>
                          <td className="px-4 py-2.5 text-gray-600">{fmtRelative(r.ended_at)}</td>
                          <td className="px-4 py-2.5">
                            <span
                              className={`inline-block px-2 py-0.5 rounded text-[11px] font-bold uppercase ${
                                r.status === 'completed' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                              }`}
                            >
                              {r.status}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-mt-dark">{r.entities}</td>
                          <td className="px-4 py-2.5 text-right text-gray-600 font-mono">{fmtMinutes(r.hold_minutes)}</td>
                          <td className="px-4 py-2.5 text-right text-gray-600 font-mono">{fmtMinutes(r.duration_minutes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          </>
        )}

        {/* Footer */}
        <div className="text-xs text-gray-500 text-center pt-4">
          {status && (
            <>
              Updated {fmtRelative(status.updated_at)} · auto-refresh every 60s
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
  const successRate = status.throughput.success_rate_7d;
  const holdMins = status.wait_times.avg_hold_minutes_today ?? status.wait_times.avg_hold_minutes_7d ?? 0;

  if (successRate < 0.7) {
    return {
      level: 'red',
      headline: 'Degraded — IRS responses below baseline',
      description: `Success rate is ${Math.round(successRate * 100)}% over the last 7 days. We're triaging — pulls may be delayed.`,
    };
  }
  if (holdMins > 60 || successRate < 0.85) {
    return {
      level: 'amber',
      headline: 'Slower than usual',
      description: `IRS hold times averaging ${fmtMinutes(holdMins)} today. Pulls still completing — expect 1-2 day turnaround instead of same-day.`,
    };
  }
  return {
    level: 'green',
    headline: 'All systems operating normally',
    description: `IRS pulls completing on schedule. Average hold ${fmtMinutes(holdMins)}, ${Math.round(successRate * 100)}% success rate over 7 days.`,
  };
}

function Stat({
  label, value, sub, accent,
}: {
  label: string;
  value: number | string;
  sub?: string;
  accent: 'blue' | 'emerald' | 'amber' | 'purple' | 'red';
}) {
  const accentClass = {
    blue: 'text-blue-700',
    emerald: 'text-emerald-700',
    amber: 'text-amber-700',
    purple: 'text-purple-700',
    red: 'text-red-700',
  }[accent];
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <p className="text-xs uppercase tracking-wide text-gray-500 font-semibold">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${accentClass}`}>{value}</p>
      {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}
