/**
 * ERC (Employee Retention Credit) status report for a single entity.
 *
 * URL: /admin/erc-report/[entityId]
 *
 * Pulls every 941 transcript on file for the entity, runs the
 * lib/erc-analysis parser, and renders a per-quarter status table.
 * Built for the TaxTaker POC (May 2026) — partners taking ERC-recovery
 * contingency work need to know per-quarter whether the IRS has paid,
 * denied, has it pending, or never received the claim.
 *
 * Anyone with admin role can view. Service-role client used for the
 * heavy reads since transcripts live in private storage.
 */

import { redirect } from 'next/navigation';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';
import { buildERCReport, ercStatusLabel, type ERCStatus, type ERCQuarter } from '@/lib/erc-analysis';
import Link from 'next/link';

interface PageProps {
  params: Promise<{ entityId: string }>;
}

export default async function ERCReportPage({ params }: PageProps) {
  const { entityId } = await params;

  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null };
  if (!profile || profile.role !== 'admin') redirect('/');

  const admin = createAdminClient();

  const { data: entity } = await admin
    .from('request_entities')
    .select(`
      id, entity_name, tid, tid_kind, form_type, years, status,
      transcript_urls, transcript_html_urls, completed_at, request_id,
      requests(loan_number, clients(name))
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

  // Pull every HTML transcript on file for this entity. Both columns get
  // checked because the upload pipeline has occasionally crossed the two
  // (.html files in transcript_urls and vice versa — see Centerstone audit).
  const allUrls: string[] = Array.from(new Set([
    ...(entity.transcript_urls || []),
    ...(entity.transcript_html_urls || []),
  ])).filter((u: string) => u.endsWith('.html'));

  const transcripts: { source: string; html: string }[] = [];
  for (const url of allUrls) {
    const { data: file } = await admin.storage.from('uploads').download(url);
    if (!file) continue;
    const html = Buffer.from(await file.arrayBuffer()).toString('utf8');
    transcripts.push({ source: url, html });
  }

  const report = buildERCReport(entity.entity_name, entity.tid, transcripts);
  const clientName = (entity as any).requests?.clients?.name || 'Unknown';
  const loanNumber = (entity as any).requests?.loan_number || '';

  // -------------------------------------------------------------------------
  // Status color mapping — used by table rows + the summary chips
  // -------------------------------------------------------------------------
  const statusColor = (s: ERCStatus): { bg: string; border: string; text: string; label: string } => {
    switch (s) {
      case 'refund_returned_undelivered':
        return { bg: 'bg-amber-50',   border: 'border-amber-300',  text: 'text-amber-900',  label: '$$$ Returned' };
      case 'refund_paid':
        return { bg: 'bg-emerald-50', border: 'border-emerald-300', text: 'text-emerald-800', label: 'Paid' };
      case 'claim_pending_irs_review':
        return { bg: 'bg-blue-50',    border: 'border-blue-300',   text: 'text-blue-800',   label: 'Pending' };
      case 'claim_denied_or_reduced':
        return { bg: 'bg-red-50',     border: 'border-red-300',    text: 'text-red-800',    label: 'Denied' };
      case 'amendment_received_no_action':
        return { bg: 'bg-indigo-50',  border: 'border-indigo-300', text: 'text-indigo-800', label: 'Filed, waiting' };
      case 'no_claim_filed':
        return { bg: 'bg-gray-50',    border: 'border-gray-200',   text: 'text-gray-600',   label: 'No claim' };
      case 'unknown':
        return { bg: 'bg-gray-50',    border: 'border-gray-200',   text: 'text-gray-500',   label: 'No data' };
    }
  };

  const fmtUsd = (n: number | null): string => {
    if (n === null) return '—';
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-6">
          <Link href={`/admin/requests/${entity.request_id}`} className="text-xs text-gray-500 hover:text-gray-700">
            ← Back to request {loanNumber}
          </Link>
          <h1 className="text-2xl sm:text-3xl font-bold text-mt-dark mt-1">
            ERC Status Report — {entity.entity_name}
          </h1>
          <p className="text-gray-600 text-sm mt-1">
            {clientName} · EIN {entity.tid} · Form 941 Account Transcripts ·
            generated from {transcripts.length} transcript{transcripts.length === 1 ? '' : 's'} on file
          </p>
        </div>

        {/* Summary */}
        <div className="bg-white rounded-lg shadow border border-gray-200 p-6 mb-6">
          <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
            <h2 className="text-lg font-bold text-mt-dark">Recoverable summary</h2>
            <p className="text-xs text-gray-500">
              Generated {new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className={`rounded-lg p-4 border ${report.summary.totalRecoverable > 0 ? 'bg-amber-50 border-amber-300' : 'bg-gray-50 border-gray-200'}`}>
              <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">Total recoverable</p>
              <p className={`text-2xl font-bold mt-1 ${report.summary.totalRecoverable > 0 ? 'text-amber-700' : 'text-gray-400'}`}>
                {fmtUsd(report.summary.totalRecoverable)}
              </p>
            </div>
            <div className={`rounded-lg p-4 border ${report.summary.quartersUndelivered > 0 ? 'bg-amber-50 border-amber-300' : 'bg-gray-50 border-gray-200'}`}>
              <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">Returned</p>
              <p className={`text-2xl font-bold mt-1 ${report.summary.quartersUndelivered > 0 ? 'text-amber-700' : 'text-gray-400'}`}>{report.summary.quartersUndelivered}</p>
              <p className="text-[11px] text-gray-500">refund check returned undelivered</p>
            </div>
            <div className={`rounded-lg p-4 border ${report.summary.quartersPending > 0 ? 'bg-blue-50 border-blue-300' : 'bg-gray-50 border-gray-200'}`}>
              <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">Pending</p>
              <p className={`text-2xl font-bold mt-1 ${report.summary.quartersPending > 0 ? 'text-blue-700' : 'text-gray-400'}`}>{report.summary.quartersPending}</p>
              <p className="text-[11px] text-gray-500">at the IRS, awaiting decision</p>
            </div>
            <div className={`rounded-lg p-4 border ${report.summary.quartersMissingTranscript > 0 ? 'bg-purple-50 border-purple-300' : 'bg-gray-50 border-gray-200'}`}>
              <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">Missing data</p>
              <p className={`text-2xl font-bold mt-1 ${report.summary.quartersMissingTranscript > 0 ? 'text-purple-700' : 'text-gray-400'}`}>{report.summary.quartersMissingTranscript}</p>
              <p className="text-[11px] text-gray-500">quarter{report.summary.quartersMissingTranscript === 1 ? '' : 's'} need transcripts pulled</p>
            </div>
          </div>

          {/* Missing-quarter callout */}
          {report.missingQuarters.length > 0 && (
            <div className="bg-purple-50 border border-purple-200 rounded p-3 text-sm text-purple-900">
              <strong>Missing transcripts:</strong> {report.missingQuarters.map(q => `${q.year} Q${q.quarter}`).join(', ')}.
              To complete the analysis, pull 941 Account Transcripts for these tax periods. Some may have legitimate ERC claims that don&apos;t show here.
            </div>
          )}
        </div>

        {/* Per-quarter table */}
        <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden mb-6">
          <div className="px-5 py-3 border-b border-gray-200 bg-gray-50">
            <h2 className="text-base font-bold text-mt-dark">Per-quarter detail</h2>
            <p className="text-xs text-gray-500 mt-0.5">Eligible quarters per IRS guidance: 2020 Q2–Q4 + 2021 Q1–Q3 (most businesses). Q4 2021 only for Recovery Startup Businesses.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-600">
                <tr>
                  <th className="px-4 py-2 text-left">Quarter</th>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="px-4 py-2 text-right">ERC Credit</th>
                  <th className="px-4 py-2 text-right">Refund Issued</th>
                  <th className="px-4 py-2 text-right">Recoverable</th>
                  <th className="px-4 py-2 text-left">Deadline</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {report.quarters.map(q => {
                  const c = statusColor(q.status);
                  return (
                    <QuarterRow key={`${q.year}-Q${q.quarter}`} q={q} c={c} fmt={fmtUsd} />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Action items list — surfaces only quarters that need work */}
        {report.summary.actionRequiredCount > 0 && (
          <div className="bg-white rounded-lg shadow border border-gray-200 p-5 mb-6">
            <h2 className="text-base font-bold text-mt-dark mb-3">
              Action items ({report.summary.actionRequiredCount})
            </h2>
            <ul className="space-y-3">
              {report.quarters.filter(q => q.actionRequired).map(q => (
                <li key={`action-${q.year}-${q.quarter}`} className="border-l-4 border-amber-400 bg-amber-50 px-4 py-3 rounded-r">
                  <p className="text-sm font-semibold text-amber-900">
                    {q.year} Q{q.quarter} ({fmtUsd(q.totalRecoverable)} at stake)
                  </p>
                  <p className="text-sm text-amber-900 mt-1">{q.actionRequired}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Footnote — sourcing + caveats */}
        <div className="text-xs text-gray-500 space-y-2 pb-8">
          <p>
            <strong>How this is generated:</strong> The IRS 941 Account Transcripts on file for this
            entity are parsed for transaction codes (TC 150, 766, 846, 740, 290, 971, 976,
            977, 470) and mapped to per-quarter ERC status. Source files:{' '}
            {transcripts.map(t => t.source.split('/').pop()).join(', ')}.
          </p>
          <p>
            <strong>Filing deadlines:</strong> 2020 claims — April 15, 2024. 2021 claims —
            April 15, 2025. Under OBBBA, 2021 Q3/Q4 claims filed after Jan 31, 2024 are disallowed.
          </p>
          <p>
            <strong>Not professional tax advice.</strong> The report identifies signals from
            IRS-issued transcript data. Verify with the client&apos;s tax professional before acting.
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-quarter row — small extracted component so the JSX above stays scannable
// ---------------------------------------------------------------------------

function QuarterRow({
  q,
  c,
  fmt,
}: {
  q: ERCQuarter;
  c: { bg: string; border: string; text: string; label: string };
  fmt: (n: number | null) => string;
}) {
  return (
    <tr className="hover:bg-gray-50 align-top">
      <td className="px-4 py-3">
        <div className="font-semibold text-mt-dark">{q.year} Q{q.quarter}</div>
        <div className="text-xs text-gray-500">period ending {q.taxPeriodEnding}</div>
        {q.eligibilityNote && (
          <div className="text-[11px] text-amber-700 mt-1">⚠ {q.eligibilityNote}</div>
        )}
      </td>
      <td className="px-4 py-3">
        <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold border ${c.bg} ${c.border} ${c.text}`}>
          {c.label}
        </span>
        <div className="text-[11px] text-gray-500 mt-1">{ercStatusLabel(q.status)}</div>
        {q.notes.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-[11px] text-gray-600 list-disc list-inside max-w-xs">
            {q.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
      </td>
      <td className="px-4 py-3 text-right font-mono text-xs">
        {q.ercCreditAmount !== null ? fmt(Math.abs(q.ercCreditAmount)) : '—'}
      </td>
      <td className="px-4 py-3 text-right font-mono text-xs">
        {q.refundIssuedAmount !== null ? (
          <>
            <div className="font-semibold">{fmt(q.refundIssuedAmount)}</div>
            {q.refundIssuedDate && <div className="text-[11px] text-gray-500">{q.refundIssuedDate}</div>}
            {q.refundReturnedDate && <div className="text-[11px] text-amber-700">returned {q.refundReturnedDate}</div>}
          </>
        ) : '—'}
      </td>
      <td className={`px-4 py-3 text-right font-mono ${q.totalRecoverable > 0 ? 'text-amber-700 font-bold' : 'text-gray-400'}`}>
        {q.totalRecoverable > 0 ? fmt(q.totalRecoverable) : '—'}
      </td>
      <td className="px-4 py-3 text-xs">
        <div className={q.deadlinePassed ? 'text-red-700 font-semibold' : 'text-gray-700'}>
          {q.filingDeadline}
        </div>
        <div className="text-[11px] text-gray-500">{q.deadlinePassed ? 'passed' : 'open'}</div>
      </td>
    </tr>
  );
}
