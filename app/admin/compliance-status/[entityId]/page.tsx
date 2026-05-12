/**
 * Compliance Status Report — Tax Guard parity.
 *
 * URL: /admin/compliance-status/[entityId]
 *
 * Renders the three-section structured report (filing compliance, tax
 * liabilities by period, repayment plan status) that Banc of California
 * is using for SBA underwriting. Built for parity with the sample at
 * /sample-transcripts/compliance-report (lines 350-489).
 *
 * Reads the cached report from request_entities.gross_receipts.tax_liability_report
 * if present (set by app/api/admin/update-request/route.ts when status
 * flips to 'completed'); otherwise rebuilds on demand.
 *
 * Auth gate mirrors /admin/erc-report/[entityId]: admin sees everything,
 * manager/processor/team_member only when their profile.client_id matches
 * the entity's client_id, expert only with an active assignment.
 */
import { redirect } from 'next/navigation';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';
import { buildTaxLiabilityReport, type TaxLiabilityReport, type LiabilityRow } from '@/lib/tax-liability-report';
import Link from 'next/link';

interface PageProps {
  params: Promise<{ entityId: string }>;
}

const fmtUsd = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const liabilityChip = (status: LiabilityRow['status']): { bg: string; border: string; text: string } => {
  switch (status) {
    case 'open_collection': return { bg: 'bg-red-50',     border: 'border-red-300',     text: 'text-red-800' };
    case 'open_notice':     return { bg: 'bg-red-50',     border: 'border-red-300',     text: 'text-red-800' };
    case 'open':            return { bg: 'bg-red-50',     border: 'border-red-300',     text: 'text-red-800' };
    case 'closed_zero':     return { bg: 'bg-emerald-50', border: 'border-emerald-300', text: 'text-emerald-800' };
    case 'unfiled':         return { bg: 'bg-amber-50',   border: 'border-amber-300',   text: 'text-amber-800' };
    default:                return { bg: 'bg-gray-50',    border: 'border-gray-200',    text: 'text-gray-700' };
  }
};

export default async function ComplianceStatusReportPage({ params }: PageProps) {
  const { entityId } = await params;

  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, client_id')
    .eq('id', user.id)
    .single() as { data: { role: string; client_id: string | null } | null };
  if (!profile) redirect('/');

  const admin = createAdminClient();

  const { data: entity } = await admin
    .from('request_entities')
    .select(`
      id, entity_name, tid, form_type, status, request_id, gross_receipts,
      requests(loan_number, client_id, clients(name))
    `)
    .eq('id', entityId)
    .single() as { data: any };

  if (!entity) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <p>Entity not found.</p>
      </div>
    );
  }

  // Same auth gate as /admin/erc-report.
  const entityClientId = (entity as any).requests?.client_id;
  let canView = profile.role === 'admin';
  if (!canView && ['manager', 'processor', 'team_member'].includes(profile.role)) {
    canView = !!entityClientId && entityClientId === profile.client_id;
  }
  if (!canView && profile.role === 'expert') {
    const { data: assn } = await admin
      .from('expert_assignments')
      .select('id')
      .eq('entity_id', entityId)
      .eq('expert_id', user.id)
      .limit(1)
      .maybeSingle() as { data: any };
    canView = !!assn;
  }
  if (!canView) redirect('/');

  // Prefer the cached report (set when entity flips to 'completed') so the
  // page renders fast. Fall back to an on-demand rebuild if absent — common
  // for entities that completed before this feature shipped.
  const cached = (entity.gross_receipts as Record<string, any> | null)?.tax_liability_report as TaxLiabilityReport | undefined;
  let report: TaxLiabilityReport;
  let usedCache = false;
  if (cached && cached.generatedAt) {
    report = cached;
    usedCache = true;
  } else {
    report = await buildTaxLiabilityReport(entityId, admin);
  }

  const clientName = (entity as any).requests?.clients?.name || 'Unknown';
  const loanNumber = (entity as any).requests?.loan_number || '';

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-6">
          <Link href={`/admin/requests/${entity.request_id}`} className="text-xs text-gray-500 hover:text-gray-700">
            ← Back to request {loanNumber}
          </Link>
          <h1 className="text-2xl sm:text-3xl font-bold text-mt-dark mt-1">
            Compliance Status Report — {report.entityName}
          </h1>
          <p className="text-gray-600 text-sm mt-1">
            {clientName} · {entity.tid_kind || 'TIN'} {report.tin} · generated from {report.transcriptCount} transcript{report.transcriptCount === 1 ? '' : 's'}
            {' · '}
            {usedCache ? `cached at ${new Date(report.generatedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}` : 'computed live'}
          </p>
        </div>

        {report.dataQualityWarnings.length > 0 && (
          <div className="mb-6 bg-amber-50 border border-amber-300 rounded-lg p-4 text-sm text-amber-900">
            <p className="font-bold mb-1">Data quality notes</p>
            <ul className="list-disc list-inside space-y-1">
              {report.dataQualityWarnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}

        {/* Filing Compliance */}
        <section className="mb-8">
          <h2 className="text-lg font-bold text-mt-dark mb-4 pb-2 border-b border-gray-200 flex items-center gap-2">
            <svg className="w-5 h-5 text-mt-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Filing Compliance
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
              <p className="text-xs uppercase tracking-wide font-bold text-emerald-700 mb-2">Filed &amp; on file ✓</p>
              {report.filingCompliance.filed.length === 0 ? (
                <p className="text-emerald-900 italic">No filed returns detected.</p>
              ) : (
                <ul className="space-y-1.5 text-emerald-900">
                  {report.filingCompliance.filed.map((row, i) => (
                    <li key={i} className="flex justify-between">
                      <span>{row.formType} — {row.period}</span>
                      <span className="text-xs text-emerald-700">
                        {row.filedDate ? `filed ${row.filedDate}` : 'filed'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="bg-amber-50 border border-amber-300 rounded-lg p-4">
              <p className="text-xs uppercase tracking-wide font-bold text-amber-800 mb-2">Unfiled / late ⚠</p>
              {report.filingCompliance.unfiled.length === 0 ? (
                <p className="text-amber-900 italic">No unfiled forms detected (within transcripts on file).</p>
              ) : (
                <ul className="space-y-2 text-amber-900">
                  {report.filingCompliance.unfiled.map((row, i) => (
                    <li key={i}>
                      <div className="flex justify-between font-semibold">
                        <span>{row.formType} — {row.period}</span>
                        <span className="text-xs">{row.note ? 'overdue' : ''}</span>
                      </div>
                      {row.note && <p className="text-xs text-amber-800 mt-0.5">{row.note}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-3 italic">
            Source: Entity Transcript filing requirements cross-referenced with Account Transcript filing history (TC 150 entries). When the Entity Transcript is missing or the requirements field is unparseable, this section reports filed forms only.
          </p>
        </section>

        {/* Tax Liabilities by Period */}
        <section className="mb-8">
          <h2 className="text-lg font-bold text-mt-dark mb-4 pb-2 border-b border-gray-200 flex items-center gap-2">
            <svg className="w-5 h-5 text-mt-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Tax Liabilities by Period
          </h2>
          {report.taxLiabilities.byPeriod.length === 0 ? (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-sm text-gray-600">
              No Account Transcripts or Records of Account on file — no per-period liability data to render.
            </div>
          ) : (
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-600">
                  <tr>
                    <th className="px-4 py-2 text-left">Form / Period</th>
                    <th className="px-4 py-2 text-right">Assessed</th>
                    <th className="px-4 py-2 text-right">Paid</th>
                    <th className="px-4 py-2 text-right">Balance</th>
                    <th className="px-4 py-2 text-right">Accrued Int/Pen</th>
                    <th className="px-4 py-2 text-left">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {report.taxLiabilities.byPeriod.map((row, i) => {
                    const c = liabilityChip(row.status);
                    const balanceClass = row.balance > 0 ? 'font-bold text-red-700' : row.balance === 0 ? 'text-emerald-700' : 'text-gray-700';
                    return (
                      <tr key={i}>
                        <td className="px-4 py-2.5 font-semibold">{row.formType} — {row.period}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs">{fmtUsd(row.assessed)}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs">{fmtUsd(row.paid)}</td>
                        <td className={`px-4 py-2.5 text-right font-mono ${balanceClass}`}>{fmtUsd(row.balance)}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs text-amber-700">
                          {row.accrued !== null ? fmtUsd(row.accrued) : '—'}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold border ${c.bg} ${c.border} ${c.text}`}>
                            {row.statusLabel}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="bg-gray-50 font-semibold">
                    <td className="px-4 py-3">Total exposure</td>
                    <td className="px-4 py-3 text-right font-mono text-xs">{fmtUsd(report.taxLiabilities.totalAssessed)}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs">{fmtUsd(report.taxLiabilities.totalPaid)}</td>
                    <td className="px-4 py-3 text-right font-mono font-bold text-red-700 text-base">{fmtUsd(report.taxLiabilities.totalBalance)}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-amber-700">{fmtUsd(report.taxLiabilities.totalAccrued)}</td>
                    <td className="px-4 py-3 text-xs text-gray-600">includes accruing interest</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-gray-500 mt-3 italic">
            Sources: Account Transcripts and Records of Account on file. Per-period totals reconcile to the sum on each underlying transcript.
          </p>
        </section>

        {/* Repayment Plan Status */}
        <section className="mb-8">
          <h2 className="text-lg font-bold text-mt-dark mb-4 pb-2 border-b border-gray-200 flex items-center gap-2">
            <svg className="w-5 h-5 text-mt-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
            </svg>
            Repayment Plan Status
          </h2>
          {(() => {
            const { hasIA, hasOIC, hasCNC, details } = report.repaymentPlan;
            const hasAny = hasIA || hasOIC || hasCNC;
            const wrapClass = hasAny
              ? 'bg-emerald-50 border-l-4 border-emerald-500'
              : 'bg-amber-50 border-l-4 border-amber-500';
            const headerText = hasAny
              ? `✓ Active resolution on file: ${[
                  hasIA && 'Installment Agreement',
                  hasOIC && 'Offer in Compromise',
                  hasCNC && 'Currently Not Collectible',
                ].filter(Boolean).join(' · ')}`
              : '⚠ No active repayment plan on file';
            return (
              <div className={`${wrapClass} rounded-r p-5`}>
                <p className={`text-base font-bold mb-1 ${hasAny ? 'text-emerald-900' : 'text-amber-900'}`}>{headerText}</p>
                <ul className={`list-disc list-inside text-sm mt-2 space-y-1 ${hasAny ? 'text-emerald-900' : 'text-amber-900'}`}>
                  {details.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
                <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  <div className={`bg-white border rounded p-3 ${hasIA ? 'border-emerald-200' : 'border-amber-200'}`}>
                    <p className={`font-bold ${hasIA ? 'text-emerald-900' : 'text-amber-900'}`}>Installment Agreement</p>
                    <p className="text-gray-600 mt-1">{hasIA ? 'Detected via TC 971 (installment) on one or more periods.' : 'Not detected. Eligible: balance < $50K → Online Payment Agreement, ~24h approval.'}</p>
                  </div>
                  <div className={`bg-white border rounded p-3 ${hasOIC ? 'border-emerald-200' : 'border-amber-200'}`}>
                    <p className={`font-bold ${hasOIC ? 'text-emerald-900' : 'text-amber-900'}`}>Offer in Compromise</p>
                    <p className="text-gray-600 mt-1">{hasOIC ? 'Detected via TC 480/481/482 activity.' : 'Not detected. Generally inappropriate for small balances; OIC is for cases where IA isn\'t viable.'}</p>
                  </div>
                  <div className={`bg-white border rounded p-3 ${hasCNC ? 'border-emerald-200' : 'border-amber-200'}`}>
                    <p className={`font-bold ${hasCNC ? 'text-emerald-900' : 'text-amber-900'}`}>Currently Not Collectible</p>
                    <p className="text-gray-600 mt-1">{hasCNC ? 'Detected via TC 530.' : 'Not detected. Reserved for hardship cases — not applicable to an operating SBA-eligible business.'}</p>
                  </div>
                </div>
              </div>
            );
          })()}
          <p className="text-xs text-gray-500 mt-3 italic">
            Sources: Full Account Transcript transaction-code scan (TC 480, 481, 482, 520, 530, 971 with installment action codes). Absence of these codes confirms no plan is active.
          </p>
        </section>

        {/* Source Documents */}
        <section className="mb-8">
          <h2 className="text-lg font-bold text-mt-dark mb-4 pb-2 border-b border-gray-200">Source Documents</h2>
          {report.sourceFiles.length === 0 ? (
            <p className="text-sm text-gray-500 italic">No source files on record.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {report.sourceFiles.map((src, i) => (
                <li key={i} className="flex items-center gap-2 text-gray-700">
                  <span className="w-2 h-2 rounded-full bg-mt-green" />
                  <span className="font-mono text-xs">{src.split('/').pop()}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="mt-10 pt-6 border-t border-gray-200 text-[11px] text-gray-500 leading-relaxed">
          <p className="mb-1"><strong>About this report:</strong> The ModernTax Compliance Report is generated from raw IRS transcript data on file for this entity. All figures cite their underlying transaction code (TC) for audit defense. This document is part of the lender&apos;s permanent loan file.</p>
          <p>Questions? Reply to your delivery email or write to <span className="font-semibold">support@moderntax.io</span>.</p>
        </div>
      </div>
    </div>
  );
}
