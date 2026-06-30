'use client';

/**
 * Expert self-serve payouts — pay schedule, current-period earnings, payout
 * history, payment method, and W-9 (download blank + upload signed). The page
 * Joel asked about: "where do I access the W9 and pay schedule?"
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

interface Payouts {
  expert_name: string;
  hourly_rate: number;
  payment_method: string | null;
  pay_schedule: {
    cadence: string; period_days: number; pay_lag_days: number;
    current_period_start: string; current_period_end: string; current_pay_date: string;
  };
  current_period: { hours: number; tins_completed: number; gross_pay: number };
  periods: { period_start: string; period_end: string; pay_date: string; gross_pay: number; status: string; paid_at: string | null; payment_reference: string | null }[];
  w9: { on_file: boolean; uploaded_at: string | null; blank_form_url: string };
}

const usd = (n: number) => `$${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d: string | null) => d ? new Date(d + (d.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

export default function ExpertPayoutsPage() {
  const [data, setData] = useState<Payouts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const res = await fetch('/api/expert/payouts');
      const j = await res.json();
      if (!res.ok) { setError(j.error || 'Failed to load'); return; }
      setData(j);
    } catch { setError('Failed to load payouts'); }
  };
  useEffect(() => { load(); }, []);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true); setError(null);
    try {
      const fd = new FormData(); fd.append('file', f);
      const res = await fetch('/api/expert/payouts', { method: 'POST', body: fd });
      const j = await res.json();
      if (!res.ok) { setError(j.error || 'Upload failed'); return; }
      await load();
    } catch { setError('Upload failed'); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const statusBadge = (s: string) => {
    const map: Record<string, string> = { paid: 'bg-green-100 text-green-800', approved: 'bg-blue-100 text-blue-800', pending: 'bg-amber-100 text-amber-800' };
    return map[s] || 'bg-gray-100 text-gray-700';
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 flex justify-between items-center">
          <h1 className="text-2xl font-bold text-mt-dark">Payouts</h1>
          <Link href="/expert" className="text-sm text-gray-600 hover:text-gray-900 font-medium">&larr; Back to Expert Queue</Link>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        {error && <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}
        {!data && !error && <p className="text-gray-500">Loading…</p>}

        {data && (
          <>
            {/* Pay schedule */}
            <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
              <h2 className="text-lg font-bold text-mt-dark mb-1">Your pay schedule</h2>
              <p className="text-sm text-gray-600 mb-4">You&rsquo;re paid <strong>{data.pay_schedule.cadence}</strong> at <strong>{usd(data.hourly_rate)}/hour</strong>, about {data.pay_schedule.pay_lag_days} days after each period closes.</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                <div><p className="text-[11px] uppercase tracking-wide text-gray-500 font-bold">Current period</p><p className="text-mt-dark font-semibold">{fmtDate(data.pay_schedule.current_period_start)} – {fmtDate(data.pay_schedule.current_period_end)}</p></div>
                <div><p className="text-[11px] uppercase tracking-wide text-gray-500 font-bold">Expected pay date</p><p className="text-mt-dark font-semibold">{fmtDate(data.pay_schedule.current_pay_date)}</p></div>
                <div><p className="text-[11px] uppercase tracking-wide text-gray-500 font-bold">Payment method</p><p className="text-mt-dark font-semibold">Direct deposit via Mercury</p><p className="text-[11px] text-gray-500 mt-0.5">You&rsquo;ll get a Mercury invite to add your bank details — payouts arrive by ACH.</p></div>
              </div>
            </div>

            {/* Current period earnings */}
            <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
              <h2 className="text-lg font-bold text-mt-dark mb-4">This period so far</h2>
              <div className="grid grid-cols-3 gap-4">
                <div><p className="text-[11px] uppercase tracking-wide text-gray-500 font-bold">Hours</p><p className="text-2xl font-bold text-mt-dark">{data.current_period.hours.toFixed(2)}</p></div>
                <div><p className="text-[11px] uppercase tracking-wide text-gray-500 font-bold">TINs completed</p><p className="text-2xl font-bold text-mt-dark">{data.current_period.tins_completed}</p></div>
                <div><p className="text-[11px] uppercase tracking-wide text-gray-500 font-bold">Gross (est.)</p><p className="text-2xl font-bold text-mt-green">{usd(data.current_period.gross_pay)}</p></div>
              </div>
              <p className="text-xs text-gray-400 mt-3">Live estimate from your logged hours this period. Finalized when the period is approved.</p>
            </div>

            {/* W-9 */}
            <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
              <h2 className="text-lg font-bold text-mt-dark mb-1">Form W-9</h2>
              <p className="text-sm text-gray-600 mb-4">We need a signed W-9 on file to pay you and issue your 1099.</p>
              {data.w9.on_file ? (
                <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-3">
                  ✓ W-9 on file{data.w9.uploaded_at ? ` (uploaded ${fmtDate(data.w9.uploaded_at.slice(0, 10))})` : ''}.
                  <button onClick={() => fileRef.current?.click()} className="ml-auto text-xs font-semibold text-gray-600 underline">Replace</button>
                </div>
              ) : (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900">No W-9 on file yet — please upload one.</div>
              )}
              <div className="flex flex-wrap gap-3 mt-4">
                <a href={data.w9.blank_form_url} target="_blank" rel="noopener noreferrer" className="px-4 py-2 text-sm font-semibold border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">↓ Download blank W-9</a>
                <button onClick={() => fileRef.current?.click()} disabled={uploading} className="px-4 py-2 text-sm font-semibold bg-mt-green text-white rounded-lg hover:opacity-90 disabled:opacity-50">{uploading ? 'Uploading…' : 'Upload signed W-9 (PDF)'}</button>
                <input ref={fileRef} type="file" accept="application/pdf" onChange={handleUpload} className="hidden" />
              </div>
            </div>

            {/* Payout history */}
            <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
              <h2 className="text-lg font-bold text-mt-dark mb-4">Payout history</h2>
              {data.periods.length === 0 ? (
                <p className="text-sm text-gray-500">No finalized pay periods yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-200">
                      <th className="py-2 pr-4">Period</th><th className="py-2 pr-4">Pay date</th><th className="py-2 pr-4">Gross</th><th className="py-2 pr-4">Status</th><th className="py-2">Reference</th>
                    </tr></thead>
                    <tbody>
                      {data.periods.map((p, i) => (
                        <tr key={i} className="border-b border-gray-100">
                          <td className="py-2 pr-4">{fmtDate(p.period_start)} – {fmtDate(p.period_end)}</td>
                          <td className="py-2 pr-4">{fmtDate(p.pay_date)}</td>
                          <td className="py-2 pr-4 font-semibold">{usd(p.gross_pay)}</td>
                          <td className="py-2 pr-4"><span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(p.status)}`}>{p.status}</span></td>
                          <td className="py-2 text-gray-500">{p.payment_reference || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <p className="text-xs text-gray-400">Questions about a payout? Reply to your ModernTax onboarding email or contact support and a team member (or our support agent) will help.</p>
          </>
        )}
      </div>
    </div>
  );
}
