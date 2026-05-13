/**
 * Real-time IRS PPS call health dashboard.
 *
 * Every outbound IRS PPS call we make is a free real-time poll of IRS
 * queue health. The Retell agent's transcript gets parsed for:
 *   • IRS-announced wait time (from IVR)
 *   • Whether a callback was offered
 *   • Whether a live agent was reached
 *   • Agent name + badge (when reached)
 *
 * This page surfaces those signals in real time so the team can use
 * observed conditions to set realistic SLA expectations for customers
 * ("IRS currently 60+ min wait, callbacks unavailable today — expect
 *  24-48 hr SLA").
 *
 * Driver: Matt's 2026-05-13 ask — "The IRS PPS data for every call is
 * valuable, we need to know in real-time what the call responses are
 * as it informs our turnaround time."
 *
 * Auto-refreshes every 60s via meta refresh tag (server-rendered).
 */

import { redirect } from 'next/navigation';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';
import Link from 'next/link';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function IrsCallStatsPage() {
  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (!profile || profile.role !== 'admin') redirect('/');

  const admin = createAdminClient();
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();

  const { data: sessions } = await admin
    .from('irs_call_sessions' as any)
    .select('id, expert_name, from_number, scheduled_for, initiated_at, ended_at, duration_seconds, status, callback_status, callback_phone, irs_agent_name, irs_agent_badge, hold_duration_seconds, coaching_tags, classified_outcome, call_summary, retry_reason, error_message')
    .gte('initiated_at', since)
    .order('initiated_at', { ascending: false })
    .limit(50) as { data: any[] | null };

  const rows = sessions || [];

  // Aggregate observed wait times by hour-of-day (ET) for the last 24h
  const waitByHour = new Map<string, number[]>();
  let totalCalls = rows.length;
  let agentAnsweredCount = 0;
  let callbackOfferedCount = 0;
  let overflowCount = 0;
  let waitObservations: number[] = [];

  for (const r of rows) {
    const tags = (r.coaching_tags || []) as string[];
    for (const t of tags) {
      const waitMatch = t.match(/^wait_(\d+)min$/);
      if (waitMatch) {
        const mins = parseInt(waitMatch[1], 10);
        waitObservations.push(mins);
        if (r.initiated_at) {
          const hour = new Date(r.initiated_at).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
          if (!waitByHour.has(hour)) waitByHour.set(hour, []);
          waitByHour.get(hour)!.push(mins);
        }
      }
      if (t === 'agent_answered') agentAnsweredCount++;
      if (t === 'callback_offered') callbackOfferedCount++;
      if (t === 'overflow_rejected') overflowCount++;
    }
  }
  // Most recent observation (top of list)
  const latest = rows[0];
  const latestWaitTag = (latest?.coaching_tags || []).find((t: string) => /^wait_/.test(t));
  const latestWaitMin = latestWaitTag ? parseInt(latestWaitTag.split('_')[1], 10) : null;
  const latestCallbackOffered = (latest?.coaching_tags || []).includes('callback_offered');
  const sortedWaits = [...waitObservations].sort((a, b) => a - b);
  const medianWait = sortedWaits.length > 0 ? sortedWaits[Math.floor(sortedWaits.length / 2)] : null;
  const maxWait = sortedWaits.length > 0 ? sortedWaits[sortedWaits.length - 1] : null;

  // SLA recommendation based on observed conditions
  let slaSuggestion = 'No recent calls — insufficient data';
  if (totalCalls > 0) {
    if (callbackOfferedCount > totalCalls / 2) {
      slaSuggestion = '24h SLA achievable — callbacks regularly offered';
    } else if (medianWait !== null && medianWait > 30) {
      slaSuggestion = `48-72h SLA realistic — median observed wait ${medianWait} min with limited callback availability`;
    } else if (overflowCount > totalCalls / 3) {
      slaSuggestion = 'IRS overflow today — SLA may slip to 48-72h';
    } else {
      slaSuggestion = '24-48h SLA realistic — conditions normal';
    }
  }

  const fmtTime = (iso: string | null) => iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }) : '—';
  const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : '—';

  return (
    <>
      <meta httpEquiv="refresh" content="60" />
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-6 flex items-center justify-between flex-wrap gap-2">
            <div>
              <Link href="/admin" className="text-xs text-gray-500 hover:text-gray-700">← Admin</Link>
              <h1 className="text-2xl sm:text-3xl font-bold text-mt-dark mt-1">IRS PPS Real-Time Health</h1>
              <p className="text-gray-600 text-sm mt-1">
                Observed conditions from our outbound calls in the last 24 hours · refreshes every 60s
              </p>
            </div>
            <p className="text-xs text-gray-500">Generated {new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</p>
          </div>

          {/* Latest observation card — the headline number */}
          <div className={`rounded-lg border-l-4 p-5 mb-6 ${
            latestWaitMin === null ? 'bg-gray-50 border-gray-300 text-gray-700' :
            latestWaitMin >= 60 ? 'bg-red-50 border-red-500 text-red-900' :
            latestWaitMin >= 30 ? 'bg-amber-50 border-amber-500 text-amber-900' :
            'bg-emerald-50 border-emerald-500 text-emerald-900'
          }`}>
            <p className="text-xs uppercase tracking-wide font-bold opacity-80 mb-1">Most recent observation</p>
            {latest ? (
              <>
                <p className="text-base font-bold">
                  {latestWaitMin !== null
                    ? `IRS announced wait: ${latestWaitMin}+ min`
                    : 'Latest call did not include a wait-time announcement'}
                  {latestCallbackOffered && ' · ✓ callback offered'}
                  {!latestCallbackOffered && latestWaitMin && ' · ✗ no callback option'}
                </p>
                <p className="text-sm mt-1 opacity-90">
                  Called at {fmtTime(latest.initiated_at)} ET from {latest.from_number || '?'} ·{' '}
                  {latest.duration_seconds || 0}s · {latest.classified_outcome || 'in progress'}
                </p>
                {latest.call_summary && (
                  <p className="text-xs mt-2 italic opacity-80">&ldquo;{latest.call_summary}&rdquo;</p>
                )}
              </>
            ) : (
              <p className="text-sm">No IRS PPS calls in the last 24 hours.</p>
            )}
          </div>

          {/* Aggregate cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">Calls (24h)</p>
              <p className="text-2xl font-bold mt-1 text-mt-dark">{totalCalls}</p>
            </div>
            <div className={`bg-white border rounded-lg p-4 ${medianWait && medianWait >= 30 ? 'border-amber-300' : 'border-gray-200'}`}>
              <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">Median wait observed</p>
              <p className={`text-2xl font-bold mt-1 ${medianWait && medianWait >= 30 ? 'text-amber-700' : 'text-mt-dark'}`}>
                {medianWait !== null ? `${medianWait} min` : '—'}
              </p>
              <p className="text-[11px] text-gray-500">max {maxWait || '—'} min</p>
            </div>
            <div className={`bg-white border rounded-lg p-4 ${callbackOfferedCount > 0 ? 'border-emerald-300' : 'border-amber-300'}`}>
              <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">Callbacks offered</p>
              <p className={`text-2xl font-bold mt-1 ${callbackOfferedCount > 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
                {callbackOfferedCount}<span className="text-base text-gray-500">/{totalCalls}</span>
              </p>
              <p className="text-[11px] text-gray-500">{totalCalls > 0 ? Math.round(100 * callbackOfferedCount / totalCalls) : 0}% of calls</p>
            </div>
            <div className={`bg-white border rounded-lg p-4 ${agentAnsweredCount > 0 ? 'border-emerald-300' : 'border-gray-200'}`}>
              <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">Agent reached</p>
              <p className={`text-2xl font-bold mt-1 ${agentAnsweredCount > 0 ? 'text-emerald-700' : 'text-mt-dark'}`}>
                {agentAnsweredCount}<span className="text-base text-gray-500">/{totalCalls}</span>
              </p>
              <p className="text-[11px] text-gray-500">{overflowCount > 0 ? `${overflowCount} overflow rejected` : ''}</p>
            </div>
          </div>

          {/* SLA suggestion */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
            <p className="text-xs uppercase tracking-wide font-bold text-blue-900 mb-1">Recommended SLA for new requests</p>
            <p className="text-sm font-semibold text-blue-900">{slaSuggestion}</p>
          </div>

          {/* Wait-time by hour-of-day */}
          {waitByHour.size > 0 && (
            <div className="bg-white border border-gray-200 rounded-lg p-5 mb-6">
              <h2 className="text-base font-bold text-mt-dark mb-3">Observed wait time by hour (ET, last 24h)</h2>
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-gray-600">
                  <tr className="border-b border-gray-200">
                    <th className="px-3 py-2 text-left">Hour ET</th>
                    <th className="px-3 py-2 text-right">Calls</th>
                    <th className="px-3 py-2 text-right">Min wait</th>
                    <th className="px-3 py-2 text-right">Max wait</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {[...waitByHour.entries()].sort((a, b) => parseInt(a[0]) - parseInt(b[0])).map(([hour, waits]) => {
                    const min = Math.min(...waits);
                    const max = Math.max(...waits);
                    return (
                      <tr key={hour}>
                        <td className="px-3 py-2 font-semibold">{parseInt(hour) % 12 || 12}{parseInt(hour) >= 12 ? ' PM' : ' AM'}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs">{waits.length}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs">{min} min</td>
                        <td className={`px-3 py-2 text-right font-mono text-xs ${max >= 60 ? 'text-red-700 font-bold' : max >= 30 ? 'text-amber-700' : 'text-emerald-700'}`}>{max} min</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Per-call detail */}
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <h2 className="text-base font-bold text-mt-dark mb-3">Recent calls</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-gray-600">
                  <tr className="border-b border-gray-200">
                    <th className="px-3 py-2 text-left">When</th>
                    <th className="px-3 py-2 text-left">From</th>
                    <th className="px-3 py-2 text-right">Duration</th>
                    <th className="px-3 py-2 text-left">Outcome</th>
                    <th className="px-3 py-2 text-left">Signals</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.length === 0 ? (
                    <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-gray-500">No calls in the last 24 hours.</td></tr>
                  ) : rows.map((r: any) => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2.5 font-mono text-xs">{fmtDate(r.initiated_at)}</td>
                      <td className="px-3 py-2.5 font-mono text-xs">{r.from_number || '—'}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs">{r.duration_seconds ? `${r.duration_seconds}s` : (r.status === 'ringing' ? 'live' : '—')}</td>
                      <td className="px-3 py-2.5">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold border ${
                          r.classified_outcome === 'agent_answered' ? 'bg-emerald-50 border-emerald-300 text-emerald-800' :
                          r.classified_outcome === 'callback_offered_but_not_taken' ? 'bg-blue-50 border-blue-300 text-blue-800' :
                          r.classified_outcome === 'overflow_rejected' ? 'bg-red-50 border-red-300 text-red-800' :
                          r.classified_outcome === 'wait_too_long_no_callback' ? 'bg-amber-50 border-amber-300 text-amber-900' :
                          'bg-gray-50 border-gray-200 text-gray-600'
                        }`}>{(r.classified_outcome || r.status || '—').replace(/_/g, ' ')}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {(r.coaching_tags || []).map((t: string, i: number) => (
                            <span key={i} className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-700 border border-gray-200">{t.replace(/_/g, ' ')}</span>
                          ))}
                        </div>
                        {r.irs_agent_name && <p className="text-[11px] text-gray-500 mt-1">{r.irs_agent_name}{r.irs_agent_badge ? ` · #${r.irs_agent_badge}` : ''}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-xs text-gray-500 mt-6 text-center">
            Signal extraction by lib/irs-pps-signal-extractor on each call&apos;s Retell transcript. Page auto-refreshes every 60 seconds.
          </p>
        </div>
      </div>
    </>
  );
}
