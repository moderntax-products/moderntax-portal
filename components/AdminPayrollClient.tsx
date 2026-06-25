'use client';

/**
 * AdminPayrollClient — cross-expert payroll dashboard.
 *
 * Two columns:
 *   - Sidebar of pay periods (current + recent) so admin can scrub through history.
 *   - Main panel: per-expert rows for the selected period with live totals
 *     (hours / TINs / efficiency / SLA-met %) and per-row actions:
 *         "Close period" — upsert expert_pay_periods row with status='approved'
 *         "Mark paid"    — flip status to 'paid' + record Stripe ref
 *
 * Live totals re-derive from expert_time_logs + expert_assignments on
 * every fetch so admin always sees current numbers, not stale snapshots.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

interface ExpertSummary {
  expert_id: string;
  expert_name: string;
  expert_email: string;
  hourly_rate: number;
  target_tins_per_hour: number;
  payment_method: string;
  log_count: number;
  live_totals: {
    hours: number;
    tinsCompleted: number;
    expectedTins: number;
    efficiencyPct: number;
    grossPay: number;
  };
  sla_met_pct: number | null;
  /** Number of currently-open clock-in sessions (no end_at). Admin should
   *  prompt the expert to close them before period-close so the hours
   *  actually count. Auto-closer cron handles >12h leftovers. */
  open_session_count?: number;
  open_session_oldest_start?: string | null;
  existing_period: {
    id: string;
    status: string;
    paid_at: string | null;
    payment_reference: string | null;
    gross_pay: number;
    notes: string | null;
    mercury_payout_request_id?: string | null;
    mercury_payout_status?: string | null;
  } | null;
}

interface PayrollPayload {
  period: { start: string; end: string; pay_date: string };
  experts: ExpertSummary[];
  total_gross: number;
}

const fmt$ = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (p: number | null) => (p === null || p === undefined ? '—' : p.toFixed(0) + '%');
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function AdminPayrollClient() {
  const [data, setData] = useState<PayrollPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyExpertId, setBusyExpertId] = useState<string | null>(null);
  const [periodOverride, setPeriodOverride] = useState<{ start: string; end: string } | null>(null);
  const [paymentRefs, setPaymentRefs] = useState<Record<string, string>>({});
  const [draftMsg, setDraftMsg] = useState<Record<string, string>>({});
  const [syncing, setSyncing] = useState(false);

  const handleSyncRecipients = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/admin/expert-recipients-sync', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) { setError(json.detail || json.error || 'Sync failed'); return; }
      setError(null);
      window.alert(`Mercury recipients synced.\n\nCreated + invited: ${json.created}\nLinked to existing: ${json.matched}\nAlready linked: ${json.already_linked}\nTotal experts: ${json.total_experts}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const handleDraftMercury = async (period_id: string, expert_id: string) => {
    setBusyExpertId(expert_id);
    setDraftMsg({ ...draftMsg, [period_id]: '' });
    try {
      const res = await fetch('/api/admin/expert-payout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_id }),
      });
      const json = await res.json();
      if (!res.ok) { setDraftMsg({ ...draftMsg, [period_id]: `⚠ ${json.detail || json.error}` }); return; }
      setDraftMsg({ ...draftMsg, [period_id]: `✓ Drafted in Mercury (${json.mercury_status}) — approve it in Mercury to release.` });
      await refresh();
    } catch (err) {
      setDraftMsg({ ...draftMsg, [period_id]: err instanceof Error ? err.message : 'Mercury draft failed' });
    } finally {
      setBusyExpertId(null);
    }
  };

  const refresh = useCallback(async () => {
    try {
      const url = periodOverride
        ? `/api/admin/payroll?period_start=${periodOverride.start}&period_end=${periodOverride.end}`
        : '/api/admin/payroll';
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as PayrollPayload;
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [periodOverride]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleClosePeriod = async (expert_id: string) => {
    if (!data) return;
    setBusyExpertId(expert_id);
    try {
      const res = await fetch('/api/admin/payroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'close_period',
          expert_id,
          period_start: data.period.start,
          period_end: data.period.end,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.detail || json.error);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Close period failed');
    } finally {
      setBusyExpertId(null);
    }
  };

  const handleMarkPaid = async (period_id: string, expert_id: string) => {
    setBusyExpertId(expert_id);
    try {
      const res = await fetch('/api/admin/payroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'mark_paid',
          period_id,
          payment_reference: paymentRefs[period_id] || '',
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.detail || json.error);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Mark paid failed');
    } finally {
      setBusyExpertId(null);
    }
  };

  if (!data) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-500 text-sm">{error ? `Error: ${error}` : 'Loading payroll…'}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-widest text-gray-500 mb-1">Admin</p>
            <h1 className="text-2xl font-bold text-mt-dark">Payroll</h1>
            <p className="text-sm text-gray-600 mt-1">
              Pay period {fmtDate(data.period.start)} – {fmtDate(data.period.end)} · pay date {fmtDate(data.period.pay_date)}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-xs uppercase tracking-widest text-gray-500 font-bold">Period gross</p>
              <p className="text-2xl font-bold text-mt-green font-mono">{fmt$(data.total_gross)}</p>
            </div>
            <button
              onClick={handleSyncRecipients}
              disabled={syncing}
              title="Create/link a Mercury recipient for every expert so Mercury invites them to add their bank details"
              className="px-4 py-2 text-sm font-bold rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50"
            >
              {syncing ? 'Syncing…' : 'Sync experts → Mercury'}
            </button>
            <Link href="/admin" className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50">
              ← Admin home
            </Link>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>
        )}

        {/* Period scrubber */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500 font-semibold uppercase">Period:</span>
          <button
            onClick={() => setPeriodOverride(null)}
            className={`px-3 py-1 rounded-full font-semibold ${!periodOverride ? 'bg-mt-dark text-white' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'}`}
          >
            Current
          </button>
          {[1, 2, 3].map(i => {
            const ms14 = 14 * 24 * 3600 * 1000;
            const start = new Date(new Date(data.period.start).getTime() - i * ms14).toISOString().slice(0, 10);
            const end = new Date(new Date(data.period.end).getTime() - i * ms14).toISOString().slice(0, 10);
            const isActive = periodOverride?.start === start;
            return (
              <button
                key={i}
                onClick={() => setPeriodOverride({ start, end })}
                className={`px-3 py-1 rounded-full font-semibold ${isActive ? 'bg-mt-dark text-white' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'}`}
              >
                −{i * 2}w
              </button>
            );
          })}
        </div>

        {/* Per-expert rows */}
        {data.experts.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <p className="text-sm text-gray-500">No experts found.</p>
          </div>
        ) : (
          data.experts.map(ex => (
            <div key={ex.expert_id} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <div className="p-5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
                  <h3 className="text-base font-bold text-mt-dark">{ex.expert_name}</h3>
                  <span className="text-xs text-gray-500">{ex.expert_email}</span>
                  <span className="text-xs text-gray-500">· {fmt$(ex.hourly_rate)}/hr</span>
                  <span className="text-xs text-gray-500">· target {ex.target_tins_per_hour.toFixed(2)} TINs/hr</span>
                  <span className="text-xs text-gray-400">· {ex.payment_method}</span>
                  {ex.existing_period && (
                    <span className={`ml-auto inline-block px-2 py-0.5 rounded text-[11px] font-bold uppercase ${
                      ex.existing_period.status === 'paid' ? 'bg-emerald-100 text-emerald-800'
                      : ex.existing_period.status === 'approved' ? 'bg-blue-100 text-blue-800'
                      : 'bg-amber-100 text-amber-800'
                    }`}>{ex.existing_period.status}</span>
                  )}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 text-sm mb-4">
                  <Stat label="Sessions" value={ex.log_count} />
                  <Stat label="Hours" value={ex.live_totals.hours.toFixed(2)} />
                  <Stat label="TINs" value={ex.live_totals.tinsCompleted} />
                  <Stat label="Eff." value={fmtPct(ex.live_totals.efficiencyPct)} accent={ex.live_totals.efficiencyPct >= 80 ? 'emerald' : 'amber'} />
                  <Stat label="SLA met" value={fmtPct(ex.sla_met_pct)} accent={(ex.sla_met_pct ?? 100) >= 90 ? 'emerald' : 'amber'} />
                  <Stat label="Gross" value={fmt$(ex.live_totals.grossPay)} accent="emerald" />
                </div>

                {/* Open-session warning. Admin should ping the expert to clock
                    out before close-period; otherwise those hours go unpaid. */}
                {(ex.open_session_count || 0) > 0 && (
                  <div className="mb-3 rounded-md bg-amber-50 border border-amber-300 px-3 py-2 text-xs text-amber-900 flex items-start gap-2">
                    <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <span>
                      <strong>{ex.open_session_count} open clock-in{ex.open_session_count === 1 ? '' : 's'}</strong> — these hours won&rsquo;t count until the expert clocks out
                      {ex.open_session_oldest_start && ` (oldest: ${new Date(ex.open_session_oldest_start).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })})`}.
                      Auto-closer fires daily at 7 AM PT for sessions &gt;12h.
                    </span>
                  </div>
                )}

                {/* Actions */}
                <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 pt-3">
                  {!ex.existing_period ? (
                    <button
                      onClick={() => handleClosePeriod(ex.expert_id)}
                      disabled={busyExpertId === ex.expert_id || ex.live_totals.hours === 0}
                      className="px-4 py-2 text-sm font-bold rounded-lg bg-mt-dark text-white hover:bg-mt-dark/90 disabled:opacity-50"
                    >
                      {busyExpertId === ex.expert_id ? 'Closing…' : ex.live_totals.hours === 0 ? 'No hours yet' : 'Close period (approve)'}
                    </button>
                  ) : ex.existing_period.status !== 'paid' ? (
                    <>
                      <input
                        type="text"
                        value={paymentRefs[ex.existing_period.id] || ''}
                        onChange={(e) => setPaymentRefs({ ...paymentRefs, [ex.existing_period!.id]: e.target.value })}
                        placeholder="Stripe transfer ref / check #"
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
                      />
                      <button
                        onClick={() => handleMarkPaid(ex.existing_period!.id, ex.expert_id)}
                        disabled={busyExpertId === ex.expert_id}
                        className="px-4 py-2 text-sm font-bold rounded-lg bg-mt-green text-white hover:bg-mt-green/90 disabled:opacity-50"
                      >
                        {busyExpertId === ex.expert_id ? 'Saving…' : 'Mark paid'}
                      </button>
                      <button
                        onClick={() => handleClosePeriod(ex.expert_id)}
                        disabled={busyExpertId === ex.expert_id}
                        className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                        title="Re-roll totals if more sessions came in after approval"
                      >
                        Re-roll
                      </button>
                      {ex.existing_period.mercury_payout_request_id ? (
                        <span className="px-3 py-2 text-xs font-semibold text-purple-700 bg-purple-50 border border-purple-200 rounded-lg">
                          Mercury: {ex.existing_period.mercury_payout_status || 'drafted'} — approve in Mercury
                        </span>
                      ) : (
                        <button
                          onClick={() => handleDraftMercury(ex.existing_period!.id, ex.expert_id)}
                          disabled={busyExpertId === ex.expert_id}
                          className="px-4 py-2 text-sm font-bold rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50"
                          title="Draft an ACH payout in Mercury — you approve it in Mercury before money moves"
                        >
                          {busyExpertId === ex.expert_id ? 'Drafting…' : 'Draft Mercury payout'}
                        </button>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-emerald-700 font-semibold">
                      ✓ Paid {ex.existing_period.paid_at ? `on ${new Date(ex.existing_period.paid_at).toLocaleDateString()}` : ''}
                      {ex.existing_period.payment_reference && <span className="text-gray-500 ml-2 font-mono">· ref {ex.existing_period.payment_reference}</span>}
                    </p>
                  )}
                </div>
                {ex.existing_period && draftMsg[ex.existing_period.id] && (
                  <p className={`mt-2 text-xs ${draftMsg[ex.existing_period.id].startsWith('⚠') ? 'text-red-600' : 'text-purple-700'}`}>
                    {draftMsg[ex.existing_period.id]}
                  </p>
                )}
              </div>
            </div>
          ))
        )}

        {/* Footer note */}
        <div className="text-xs text-gray-500 pt-4 border-t border-gray-200">
          <p>Live totals re-derive from time logs + expert_assignments on every load — admin always sees current numbers. &quot;Close period&quot; snapshots the totals into expert_pay_periods so they don&apos;t drift after you approve. &quot;Re-roll&quot; updates an already-approved snapshot if late sessions come in.</p>
          <p className="mt-1">Stripe Connect auto-payout integration is Phase 2 — for now Mark Paid records the manual payment reference for audit.</p>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number | string; accent?: 'emerald' | 'amber' | 'red' }) {
  const tone = accent === 'emerald' ? 'text-emerald-700' : accent === 'amber' ? 'text-amber-700' : accent === 'red' ? 'text-red-700' : 'text-mt-dark';
  return (
    <div className="bg-gray-50 rounded p-2">
      <p className="text-[10px] uppercase tracking-wide text-gray-500 font-bold">{label}</p>
      <p className={`text-base font-bold ${tone} font-mono`}>{value}</p>
    </div>
  );
}
