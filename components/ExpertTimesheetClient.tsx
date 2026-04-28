'use client';

/**
 * ExpertTimesheetClient — clock-in/out UI + current-period summary +
 * recent sessions + recent pay periods.
 *
 * Polls /api/expert/timesheet every 30s while a session is open so the
 * running clock + auto-counted TINs stay fresh. After clock-out the
 * polling slows because nothing live changes.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

interface Profile {
  hourly_rate: number;
  target_tins_per_hour: number;
  payment_method: string;
  iana_timezone: string;
}
interface ActiveSession {
  id: string;
  start_at: string;
}
interface PeriodTotals {
  hours: number;
  tinsCompleted: number;
  expectedTins: number;
  efficiencyPct: number;
  grossPay: number;
}
interface CurrentPeriod {
  period_start: string;
  period_end: string;
  pay_date: string;
  totals: PeriodTotals;
  sla_met_pct: number | null;
  log_count: number;
}
interface PayPeriodRow {
  id: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  total_hours: number;
  total_tins: number;
  expected_tins: number;
  efficiency_pct: number;
  sla_met_pct: number | null;
  gross_pay: number;
  status: string;
  paid_at: string | null;
  payment_reference: string | null;
  notes: string | null;
}
interface LogRow {
  id: string;
  start_at: string;
  end_at: string | null;
  hours_worked: number | null;
  tins_completed: number;
  break_minutes: number;
  notes: string | null;
  pay_period_id: string | null;
}

interface ApiPayload {
  profile: Profile;
  active_session: ActiveSession | null;
  current_period: CurrentPeriod;
  recent_periods: PayPeriodRow[];
  recent_logs: LogRow[];
}

const fmt$ = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtHours = (h: number | null) => (h === null || h === undefined ? '—' : h.toFixed(2) + 'h');
const fmtPct = (p: number | null) => (p === null || p === undefined ? '—' : p.toFixed(0) + '%');
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');

function liveHoursFor(startIso: string, breakMinutes = 0): number {
  const ms = Math.max(0, Date.now() - new Date(startIso).getTime()) - breakMinutes * 60_000;
  return Math.max(0, ms / 3_600_000);
}

export function ExpertTimesheetClient({ expertName }: { expertName: string | null }) {
  const [data, setData] = useState<ApiPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [breakMinutes, setBreakMinutes] = useState(0);
  const [notes, setNotes] = useState('');
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/expert/timesheet', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ApiPayload;
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // While clocked in, tick the running counter every second. Refresh
  // server data every 30s so auto-counted TINs stay current.
  useEffect(() => {
    if (!data?.active_session) return;
    const tickInterval = setInterval(() => setTick(t => t + 1), 1000);
    const refreshInterval = setInterval(refresh, 30_000);
    return () => { clearInterval(tickInterval); clearInterval(refreshInterval); };
  }, [data?.active_session, refresh]);

  const handleAction = async (action: 'clock_in' | 'clock_out') => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { action };
      if (action === 'clock_out') {
        body.break_minutes = breakMinutes;
        body.notes = notes.trim() || null;
      }
      const res = await fetch('/api/expert/timesheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.detail || json.error || 'Action failed');
      setNotes('');
      setBreakMinutes(0);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-500 text-sm">Loading timesheet…</p>
      </div>
    );
  }

  const { profile, active_session, current_period, recent_periods, recent_logs } = data;
  // Live totals if clocked in (otherwise use server-rolled-up totals)
  const liveExtraHours = active_session ? liveHoursFor(active_session.start_at) : 0;
  const liveTotalHours = current_period.totals.hours + (active_session ? liveExtraHours - (recent_logs.find(l => l.id === active_session.id)?.hours_worked || 0) : 0);
  // ^ subtract whatever's already counted from the open session's stored hours_worked (NULL until clock-out, so usually 0)
  const liveExpected = liveTotalHours * profile.target_tins_per_hour;
  const liveEfficiency = liveExpected > 0 ? (current_period.totals.tinsCompleted / liveExpected) * 100 : 0;
  const liveGross = liveTotalHours * profile.hourly_rate;

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <p className="text-xs uppercase tracking-widest text-gray-500 mb-1">Expert</p>
            <h1 className="text-2xl font-bold text-mt-dark">Timesheet</h1>
            <p className="text-sm text-gray-500 mt-1">
              {expertName} · {fmt$(profile.hourly_rate)}/hr · target {profile.target_tins_per_hour.toFixed(2)} TINs/hr
            </p>
          </div>
          <Link href="/expert" className="text-sm text-gray-600 hover:text-gray-900 font-medium">
            ← Back to queue
          </Link>
        </div>

        {/* Clock card */}
        <div className={`bg-white rounded-xl border-2 ${active_session ? 'border-emerald-300 bg-emerald-50/40' : 'border-gray-200'} p-6 mb-6`}>
          {active_session ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="relative flex w-3 h-3">
                      <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-500 opacity-75 animate-ping" />
                      <span className="relative inline-flex w-3 h-3 rounded-full bg-emerald-500" />
                    </span>
                    <p className="text-xs uppercase tracking-widest font-bold text-emerald-700">Clocked in</p>
                  </div>
                  <p className="text-4xl font-bold text-mt-dark font-mono">
                    {liveHoursFor(active_session.start_at).toFixed(2)}h
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    Started {new Date(active_session.start_at).toLocaleTimeString()} · running counter (tick {tick})
                  </p>
                </div>
                <div>
                  <button
                    type="button"
                    onClick={() => handleAction('clock_out')}
                    disabled={busy}
                    className="px-6 py-3 bg-red-600 text-white text-sm font-bold rounded-lg hover:bg-red-700 disabled:opacity-50"
                  >
                    {busy ? 'Saving…' : 'Clock out'}
                  </button>
                </div>
              </div>
              {/* Optional break + notes captured on clock-out */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Break (minutes)</label>
                  <input
                    type="number"
                    min={0}
                    step={5}
                    value={breakMinutes}
                    onChange={(e) => setBreakMinutes(Math.max(0, parseInt(e.target.value, 10) || 0))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Session notes</label>
                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="e.g., Slow IRS reps tonight, 3rd company missed in IRS DB"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-widest font-bold text-gray-500">Not clocked in</p>
                <p className="text-sm text-gray-600 mt-1">
                  Hit the button when you start a work session. We auto-count TINs you complete during the session.
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleAction('clock_in')}
                disabled={busy}
                className="px-6 py-3 bg-mt-green text-white text-sm font-bold rounded-lg hover:bg-mt-green/90 disabled:opacity-50"
              >
                {busy ? 'Starting…' : 'Clock in'}
              </button>
            </div>
          )}
          {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
        </div>

        {/* Current pay period summary */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-xs uppercase tracking-widest font-bold text-gray-500">Current pay period</p>
              <p className="text-sm text-mt-dark font-semibold mt-0.5">
                {fmtDate(current_period.period_start)} – {fmtDate(current_period.period_end)} · pay date {fmtDate(current_period.pay_date)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase text-gray-500 font-bold">Projected pay</p>
              <p className="text-3xl font-bold text-mt-green font-mono">{fmt$(active_session ? liveGross : current_period.totals.grossPay)}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
            <Stat label="Hours" value={fmtHours(active_session ? liveTotalHours : current_period.totals.hours)} />
            <Stat label="TINs done" value={current_period.totals.tinsCompleted} />
            <Stat label="Expected" value={(active_session ? liveExpected : current_period.totals.expectedTins).toFixed(1)} />
            <Stat
              label="Efficiency"
              value={fmtPct(active_session ? liveEfficiency : current_period.totals.efficiencyPct)}
              accent={(active_session ? liveEfficiency : current_period.totals.efficiencyPct) >= 80 ? 'emerald' : 'amber'}
            />
            <Stat
              label="SLA met"
              value={fmtPct(current_period.sla_met_pct)}
              accent={(current_period.sla_met_pct ?? 100) >= 90 ? 'emerald' : 'amber'}
            />
          </div>
        </div>

        {/* Recent sessions */}
        <div className="bg-white rounded-xl border border-gray-200 mb-6 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-700">Recent sessions</h2>
          </div>
          {recent_logs.length === 0 ? (
            <p className="p-6 text-sm text-gray-500 text-center">No sessions logged yet — clock in to start tracking.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="text-left px-4 py-2.5">Date</th>
                  <th className="text-left px-4 py-2.5">Start</th>
                  <th className="text-left px-4 py-2.5">End</th>
                  <th className="text-right px-4 py-2.5">Break</th>
                  <th className="text-right px-4 py-2.5">Hours</th>
                  <th className="text-right px-4 py-2.5">TINs</th>
                  <th className="text-left px-4 py-2.5">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {recent_logs.map(l => (
                  <tr key={l.id}>
                    <td className="px-4 py-2.5 text-gray-700">{new Date(l.start_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{new Date(l.start_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{l.end_at ? new Date(l.end_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : <span className="text-emerald-600 font-bold">live</span>}</td>
                    <td className="px-4 py-2.5 text-right text-gray-600">{l.break_minutes}m</td>
                    <td className="px-4 py-2.5 text-right font-mono text-mt-dark">{fmtHours(l.hours_worked)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-mt-dark">{l.tins_completed}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 max-w-[280px] truncate" title={l.notes || ''}>{l.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pay period history */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-700">Pay period history</h2>
          </div>
          {recent_periods.length === 0 ? (
            <p className="p-6 text-sm text-gray-500 text-center">No closed pay periods yet. Once admin approves a period, it shows up here with payment status.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="text-left px-4 py-2.5">Period</th>
                  <th className="text-left px-4 py-2.5">Pay date</th>
                  <th className="text-right px-4 py-2.5">Hours</th>
                  <th className="text-right px-4 py-2.5">TINs</th>
                  <th className="text-right px-4 py-2.5">Eff.</th>
                  <th className="text-right px-4 py-2.5">SLA met</th>
                  <th className="text-right px-4 py-2.5">Pay</th>
                  <th className="text-left px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {recent_periods.map(p => (
                  <tr key={p.id}>
                    <td className="px-4 py-2.5 text-gray-700">{fmtDate(p.period_start)} – {fmtDate(p.period_end)}</td>
                    <td className="px-4 py-2.5 text-gray-600">{fmtDate(p.pay_date)}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{fmtHours(p.total_hours)}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{p.total_tins}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{fmtPct(p.efficiency_pct)}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{fmtPct(p.sla_met_pct)}</td>
                    <td className="px-4 py-2.5 text-right font-mono font-bold text-mt-dark">{fmt$(Number(p.gross_pay))}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-bold uppercase ${
                        p.status === 'paid' ? 'bg-emerald-100 text-emerald-800'
                        : p.status === 'partial' ? 'bg-blue-100 text-blue-800'
                        : p.status === 'cancelled' ? 'bg-gray-200 text-gray-600'
                        : 'bg-amber-100 text-amber-800'
                      }`}>{p.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number | string; accent?: 'emerald' | 'amber' | 'red' }) {
  const tone = accent === 'emerald' ? 'text-emerald-700' : accent === 'amber' ? 'text-amber-700' : accent === 'red' ? 'text-red-700' : 'text-mt-dark';
  return (
    <div className="bg-gray-50 rounded p-3">
      <p className="text-[10px] uppercase tracking-wide text-gray-500 font-bold">{label}</p>
      <p className={`text-lg font-bold ${tone} mt-1 font-mono`}>{value}</p>
    </div>
  );
}
