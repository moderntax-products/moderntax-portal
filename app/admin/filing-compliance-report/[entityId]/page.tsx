/**
 * Filing-Compliance Report (MOD-228 Phase 5) — the customer-facing deliverable
 * for the Filing-Compliance Report product. Reads the entity's IRS Account
 * Transcripts and renders a Tax-Guard-style funding-risk report in four
 * sections (modeled on the competitor report Matt shared):
 *   1. Verify Client Information   2. Report Summary (at-a-glance)
 *   3. Tax Liability Details        4. Tax Compliance Overview
 *
 * Access: admin (all), manager/processor (own client), assigned expert.
 * Reuses the transcript-loading + access pattern from the ERC report page.
 * ⚠️ The transcript parser (lib/compliance-report) needs validation against
 * real Account Transcripts (lien/levy/IA detection especially) before being
 * leaned on for funding decisions — see the footer disclaimer.
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';
import { buildComplianceReport } from '@/lib/compliance-report';

export const dynamic = 'force-dynamic';

const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (iso: string | null) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

const BAND_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  low: { bg: 'bg-emerald-50 border-emerald-300', text: 'text-emerald-700', label: 'Low Risk' },
  moderate: { bg: 'bg-yellow-50 border-yellow-300', text: 'text-yellow-700', label: 'Moderate Risk' },
  elevated: { bg: 'bg-orange-50 border-orange-300', text: 'text-orange-700', label: 'Elevated Risk' },
  high: { bg: 'bg-red-50 border-red-300', text: 'text-red-700', label: 'High Risk' },
};

const IA_LABEL: Record<string, string> = {
  none: 'None',
  good_standing: 'Good Standing',
  potential_default: 'Potential for Default',
};

export default async function FilingComplianceReportPage({ params }: { params: Promise<{ entityId: string }> }) {
  const { entityId } = await params;

  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: profile } = await supabase
    .from('profiles').select('role, client_id').eq('id', user.id).single() as { data: { role: string; client_id: string | null } | null };
  if (!profile) redirect('/');

  const admin = createAdminClient();
  const { data: entity } = await admin
    .from('request_entities')
    .select('id, entity_name, tid, tid_kind, form_type, years, status, transcript_urls, transcript_html_urls, request_id, requests(loan_number, client_id, clients(name))')
    .eq('id', entityId).single() as { data: any };
  if (!entity) {
    return <div className="max-w-3xl mx-auto p-8"><p>Entity not found.</p></div>;
  }

  const entityClientId = entity.requests?.client_id;
  let canView = profile.role === 'admin';
  if (!canView && ['manager', 'processor', 'team_member'].includes(profile.role)) {
    canView = !!entityClientId && entityClientId === profile.client_id;
  }
  if (!canView && profile.role === 'expert') {
    const { data: assn } = await admin.from('expert_assignments')
      .select('id').eq('entity_id', entityId).eq('expert_id', user.id).limit(1).maybeSingle() as { data: any };
    canView = !!assn;
  }
  if (!canView) redirect('/');

  const allUrls: string[] = Array.from(new Set([
    ...(entity.transcript_urls || []),
    ...(entity.transcript_html_urls || []),
  ])).filter((u: string) => u.endsWith('.html'));

  const transcripts: { source: string; html: string }[] = [];
  for (const url of allUrls) {
    const { data: file } = await admin.storage.from('uploads').download(url);
    if (!file) continue;
    transcripts.push({ source: url, html: Buffer.from(await file.arrayBuffer()).toString('utf8') });
  }

  const report = buildComplianceReport(entity.entity_name, entity.tid, transcripts);
  const clientName = entity.requests?.clients?.name || 'Unknown';
  const loanNumber = entity.requests?.loan_number || '';
  const band = BAND_STYLE[report.summary.riskBand];

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link href={`/admin/requests/${entity.request_id}`} className="text-xs text-gray-500 hover:text-gray-700">← Back to request</Link>
        <h1 className="text-2xl sm:text-3xl font-bold text-mt-dark mt-1">Tax Compliance Report</h1>
        <p className="text-sm text-gray-600 mt-1">
          {entity.entity_name} · {clientName}{loanNumber ? ` · loan ${loanNumber}` : ''} · {entity.tid_kind} {entity.tid}
        </p>
        {transcripts.length === 0 && (
          <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
            No IRS Account Transcripts are on file for this entity yet. The report populates once the expert pulls the Account Transcript (filing-compliance order — account transcript only).
          </div>
        )}

        {/* SECTION 2 — Report Summary (at-a-glance) */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
          <div className={`rounded-lg p-5 border ${band.bg} md:col-span-1`}>
            <div className="text-xs uppercase tracking-wide text-gray-500">Tax Risk Score</div>
            <div className={`text-4xl font-extrabold mt-1 ${band.text}`}>{report.summary.riskScore}<span className="text-lg font-medium text-gray-400">/100</span></div>
            <div className={`text-sm font-semibold mt-1 ${band.text}`}>{band.label}</div>
          </div>
          <div className="rounded-lg p-5 border bg-white md:col-span-2 grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500">Total Liability</div>
              <div className="text-xl font-bold text-gray-900 mt-1">{fmt(report.summary.totalLiability)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500">Installment Agreement</div>
              <div className="text-xl font-bold text-gray-900 mt-1">{IA_LABEL[report.summary.installmentAgreement]}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500">Liability w/ Liens Filed</div>
              <div className={`text-xl font-bold mt-1 ${report.summary.liabilityWithLiens > 0 ? 'text-red-700' : 'text-gray-900'}`}>{fmt(report.summary.liabilityWithLiens)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500">Liability at Risk for Levy</div>
              <div className={`text-xl font-bold mt-1 ${report.summary.liabilityAtRiskForLevy > 0 ? 'text-red-700' : 'text-gray-900'}`}>{fmt(report.summary.liabilityAtRiskForLevy)}</div>
            </div>
          </div>
        </div>

        {/* SECTION 1 — Verify Client Information */}
        <section className="bg-white rounded-lg border mt-6 p-5">
          <h2 className="text-base font-bold text-mt-dark mb-3">1 · Verify Client Information</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div><div className="text-xs text-gray-500 uppercase">Name on file</div><div className="font-medium text-gray-900">{report.clientInfo.name || entity.entity_name}</div></div>
            <div><div className="text-xs text-gray-500 uppercase">TIN</div><div className="font-mono text-gray-900">{report.clientInfo.tin || '—'}</div></div>
            <div><div className="text-xs text-gray-500 uppercase">Form / Entity Type</div><div className="font-medium text-gray-900">{report.clientInfo.formTypes.join(', ') || entity.form_type || '—'}</div></div>
            <div><div className="text-xs text-gray-500 uppercase">Earliest IRS Activity</div><div className="font-medium text-gray-900">{fmtDate(report.clientInfo.establishmentDate)}</div></div>
          </div>
          <div className="mt-3 text-xs text-gray-500">Filing requirements / periods covered: {report.clientInfo.periodsCovered.join(', ') || '—'}</div>
        </section>

        {/* SECTION 3 — Tax Liability Details */}
        <section className="bg-white rounded-lg border mt-6">
          <div className="px-5 py-3 border-b"><h2 className="text-base font-bold text-mt-dark">3 · Tax Liability Details</h2></div>
          {report.liabilityDetail.length === 0 ? (
            <p className="px-5 py-4 text-sm text-gray-500 italic">No liability or transaction activity found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-600">
                  <tr>
                    <th className="text-left px-4 py-2">Form / Period</th>
                    <th className="text-right px-4 py-2">Return Filed</th>
                    <th className="text-right px-4 py-2">Liability</th>
                    <th className="text-right px-4 py-2">Penalties</th>
                    <th className="text-right px-4 py-2">Interest</th>
                    <th className="text-left px-4 py-2">Lien Date</th>
                    <th className="text-left px-4 py-2">Levy Risk Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {report.liabilityDetail.map((p, i) => (
                    <tr key={i} className={p.liability > 0 ? 'bg-red-50/40' : ''}>
                      <td className="px-4 py-2 font-medium">{p.formType || '—'} · {p.label}</td>
                      <td className="px-4 py-2 text-right">{p.returnFiledAmount != null ? fmt(p.returnFiledAmount) : (p.returnFiled ? 'Filed' : '—')}</td>
                      <td className={`px-4 py-2 text-right font-semibold ${p.liability > 0 ? 'text-red-700' : 'text-gray-400'}`}>{p.liability > 0 ? fmt(p.liability) : '$0.00'}</td>
                      <td className="px-4 py-2 text-right text-gray-600">{p.penalties > 0 ? fmt(p.penalties) : '—'}</td>
                      <td className="px-4 py-2 text-right text-gray-600">{p.interest > 0 ? fmt(p.interest) : '—'}</td>
                      <td className="px-4 py-2 text-xs">{p.lienDate ? <span className="text-red-700 font-medium">{fmtDate(p.lienDate)}</span> : '—'}</td>
                      <td className="px-4 py-2 text-xs">{p.levyRiskDate ? <span className="text-red-700 font-medium">{fmtDate(p.levyRiskDate)}</span> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* SECTION 4 — Tax Compliance Overview */}
        <section className="bg-white rounded-lg border mt-6 p-5">
          <h2 className="text-base font-bold text-mt-dark mb-3">4 · Tax Compliance Overview</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <div className="text-xs font-semibold text-gray-700 uppercase mb-2">Return Filing Status</div>
              <ul className="space-y-1 text-sm">
                {report.complianceOverview.filingStatus.map((f, i) => (
                  <li key={i} className="flex items-center justify-between">
                    <span className="text-gray-700">{f.formType || ''} {f.label}</span>
                    {f.filed
                      ? <span className="text-emerald-700 text-xs font-semibold">✓ Filed</span>
                      : <span className="text-red-700 text-xs font-semibold">⚠ Unfiled</span>}
                  </li>
                ))}
                {report.complianceOverview.filingStatus.length === 0 && <li className="text-gray-400 italic">No periods on file.</li>}
              </ul>
              {report.complianceOverview.unfiledReturns.length > 0 && (
                <div className="mt-3 text-xs bg-red-50 border border-red-200 rounded px-2 py-1.5 text-red-800">
                  <strong>Unfiled returns:</strong> {report.complianceOverview.unfiledReturns.join(', ')} — potential hidden liability; monitor closely.
                </div>
              )}
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-700 uppercase mb-2">Tax Deposit Trend</div>
              {report.complianceOverview.depositTrend.length === 0 ? (
                <p className="text-sm text-gray-400 italic">No deposit activity found.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {report.complianceOverview.depositTrend.map((d, i) => (
                    <li key={i} className="flex items-center justify-between">
                      <span className="text-gray-700">{d.label}</span>
                      <span className="font-medium text-gray-900">{fmt(d.deposits)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

        <p className="mt-6 text-[11px] text-gray-400">
          Generated from {report.generatedFrom} IRS Account Transcript{report.generatedFrom === 1 ? '' : 's'} on file. The Tax Risk Score is a funding-risk heuristic derived from liability, liens, levy notices, and filing compliance — not a credit score. Verify against the source transcripts before a funding decision.
        </p>
      </div>
    </div>
  );
}
