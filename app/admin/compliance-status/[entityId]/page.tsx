/**
 * Live per-entity Compliance Status Report — the production rendering
 * of what the public sample at /sample-transcripts/compliance-report
 * shows in static demo form.
 *
 * URL: /admin/compliance-status/[entityId]
 *
 * Shipped 2026-05-13 to close the Tax-Guard-parity gap Banc of California
 * (Erin Wilsey) raised on 2026-05-12. Every completed request that has
 * IRS transcripts on file now has a corresponding compliance report
 * here — no extra cost, bundled with the standard pull.
 *
 * Access:
 *   - admin: all entities
 *   - manager / processor / team_member: entities under their own client_id
 *   - expert: entities they have an active assignment on
 *   - everyone else: redirect /
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';
import { buildTaxLiabilityReport } from '@/lib/tax-liability-report';
import { compareIncomeSnapshots, type IncomeSnapshot } from '@/lib/income-reconciliation';
import { MonitoringEnrollCTA } from '@/components/MonitoringEnrollCTA';

interface PageProps {
  params: Promise<{ entityId: string }>;
}

export default async function ComplianceStatusPage({ params }: PageProps) {
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

  const { data: entity, error: lookupErr } = await admin
    .from('request_entities')
    .select(`
      id, entity_name, tid, tid_kind, form_type, years, status,
      transcript_urls, transcript_html_urls, completed_at, request_id,
      income_baseline, income_snapshot,
      requests(loan_number, client_id, clients(name))
    `)
    .eq('id', entityId)
    .single() as { data: any; error: any };

  if (lookupErr || !entity) {
    // Log the actual error so we don't silently swallow it again
    // (this happened earlier — billing_email vs billing_ap_email schema mismatch
    // returned NULL entity for every row in the backfill, masking the real cause).
    console.error('[compliance-status] entity lookup failed:', entityId, lookupErr);
    return (
      <div className="max-w-3xl mx-auto p-8 space-y-3">
        <p className="text-sm font-semibold text-gray-900">Unable to load entity {entityId.slice(0, 8)}…</p>
        <p className="text-xs text-gray-600">
          {lookupErr
            ? `Database error: ${lookupErr.message}`
            : 'No matching entity row found. The link may reference a deleted entity, or you may not have permission to view it.'}
        </p>
        <p className="text-xs text-gray-500 italic">
          If this entity was just created, try refreshing — the build may still be picking up the latest deploy.
        </p>
      </div>
    );
  }

  // Access control mirrors /admin/erc-report/[entityId].
  const entityClientId = entity.requests?.client_id;
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

  // Collect all .html transcripts on file.
  const allUrls: string[] = Array.from(new Set([
    ...(entity.transcript_urls || []),
    ...(entity.transcript_html_urls || []),
  ])).filter((u: string) => u.endsWith('.html'));

  const transcriptInputs: { source: string; html: string }[] = [];
  for (const url of allUrls) {
    const { data: file } = await admin.storage.from('uploads').download(url);
    if (!file) continue;
    const html = Buffer.from(await file.arrayBuffer()).toString('utf8');
    transcriptInputs.push({
      source: url.split('/').pop() || url,
      html,
    });
  }

  const report = buildTaxLiabilityReport(entity.entity_name, entity.tid, transcriptInputs);
  const clientName = entity.requests?.clients?.name || 'Unknown';
  const loanNumber = entity.requests?.loan_number || '';

  // Lookup any existing monitoring subscription for this entity so the
  // upsell CTA below knows whether to show "Enroll" or "Active · next pull".
  const { data: monitoringRow } = await admin
    .from('entity_monitoring' as any)
    .select('id, status, frequency, next_pull_date, last_pull_date, total_pulls_completed')
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle() as { data: any };
  const showMonitoringCTA = profile.role === 'admin' || ['manager', 'processor', 'team_member'].includes(profile.role);

  const fmtUsd = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const severityClass = report.overallSeverity === 'CRITICAL'
    ? 'bg-red-50 border-red-500 text-red-900'
    : report.overallSeverity === 'WARNING'
      ? 'bg-amber-50 border-amber-500 text-amber-900'
      : 'bg-emerald-50 border-emerald-500 text-emerald-900';

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-6">
          <Link href={`/admin/requests/${entity.request_id}`} className="text-xs text-gray-500 hover:text-gray-700">
            ← Back to request {loanNumber}
          </Link>
          <h1 className="text-2xl sm:text-3xl font-bold text-mt-dark mt-1">
            Compliance Status Report — {entity.entity_name}
          </h1>
          <p className="text-gray-600 text-sm mt-1">
            {clientName} · {entity.tid_kind || 'TIN'} {entity.tid} ·{' '}
            generated from {report.transcriptsParsed} transcript{report.transcriptsParsed === 1 ? '' : 's'} on file
          </p>
        </div>

        {/* Headline / overall assessment */}
        <div className={`rounded-r border-l-4 p-5 mb-6 ${severityClass}`}>
          <p className="text-xs font-bold uppercase tracking-wide mb-1 opacity-80">Overall Assessment</p>
          <p className="text-base font-bold">{report.headlineSummary}</p>
        </div>

        {/* Section 1: Filing Compliance */}
        <section className="bg-white rounded-lg shadow border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-bold text-mt-dark mb-4 pb-2 border-b border-gray-200">
            Filing Compliance
          </h2>
          {report.filingCompliance.filed.length === 0 && report.filingCompliance.unfiled.length === 0 ? (
            <p className="text-sm text-gray-500">No filings detected in transcripts on file.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
                <p className="text-xs uppercase tracking-wide font-bold text-emerald-700 mb-2">
                  Filed &amp; on file ({report.filingCompliance.filed.length}) ✓
                </p>
                {report.filingCompliance.filed.length === 0 ? (
                  <p className="text-xs text-emerald-800 italic">No filed returns detected in pulled transcripts.</p>
                ) : (
                  <ul className="space-y-1.5 text-emerald-900">
                    {report.filingCompliance.filed.map((f, i) => (
                      <li key={i} className="flex justify-between gap-3">
                        <span>{f.form} — {f.period}</span>
                        <span className="text-xs text-emerald-700">{f.filedOn ? `filed ${f.filedOn}` : 'on transcript'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className={`${report.filingCompliance.unfiled.length > 0 ? 'bg-amber-50 border-amber-300' : 'bg-gray-50 border-gray-200'} border rounded-lg p-4`}>
                <p className={`text-xs uppercase tracking-wide font-bold mb-2 ${report.filingCompliance.unfiled.length > 0 ? 'text-amber-800' : 'text-gray-500'}`}>
                  Unfiled / blank ({report.filingCompliance.unfiled.length}) {report.filingCompliance.unfiled.length > 0 ? '⚠' : ''}
                </p>
                {report.filingCompliance.unfiled.length === 0 ? (
                  <p className="text-xs text-gray-600 italic">No &ldquo;no record of return filed&rdquo; results in pulled transcripts.</p>
                ) : (
                  <ul className="space-y-2 text-amber-900">
                    {report.filingCompliance.unfiled.map((f, i) => (
                      <li key={i}>
                        <div className="flex justify-between font-semibold">
                          <span>{f.form} — {f.period}</span>
                          <span className="text-xs">unfiled</span>
                        </div>
                        {f.notes.map((n, j) => (
                          <p key={j} className="text-xs text-amber-800 mt-0.5">{n}</p>
                        ))}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          <p className="text-xs text-gray-500 mt-3 italic">
            Sourced from IRS Account Transcript TC 150 entries (filed) and any &ldquo;No record of return filed&rdquo; responses (unfiled).
          </p>
          {/* Monitoring upsell — fires when ANY unfiled-return result is detected.
              Pitch: re-pull on cadence until the missing return appears. The
              no-record-found pulls are free; only fresh-data pulls bill. */}
          {showMonitoringCTA && report.filingCompliance.unfiled.length > 0 && (
            <MonitoringEnrollCTA
              entityId={entity.id}
              requestId={entity.request_id}
              unfiledCount={report.filingCompliance.unfiled.length}
              existing={monitoringRow}
            />
          )}
        </section>

        {/* Section 2: Tax Liabilities */}
        <section className="bg-white rounded-lg shadow border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-bold text-mt-dark mb-4 pb-2 border-b border-gray-200">
            Tax Liabilities by Period
          </h2>
          {report.taxLiabilities.rows.length === 0 ? (
            <p className="text-sm text-gray-500">No assessment data detected in pulled transcripts.</p>
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
                  {report.taxLiabilities.rows.map((row, i) => (
                    <tr key={i}>
                      <td className="px-4 py-2.5 font-semibold">{row.form} — {row.period}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs">{fmtUsd(row.assessed)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs">{fmtUsd(row.paid)}</td>
                      <td className={`px-4 py-2.5 text-right font-mono ${row.balance > 0 ? 'font-bold text-red-700' : 'text-gray-400'}`}>
                        {row.balance > 0 ? fmtUsd(row.balance) : '—'}
                      </td>
                      <td className={`px-4 py-2.5 text-right font-mono text-xs ${row.accrued > 0 ? 'text-amber-700' : 'text-gray-400'}`}>
                        {row.accrued > 0 ? fmtUsd(row.accrued) : '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold border ${
                          row.statusKind === 'open' ? 'bg-red-50 border-red-300 text-red-800' :
                          row.statusKind === 'partial' ? 'bg-amber-50 border-amber-300 text-amber-900' :
                          'bg-emerald-50 border-emerald-300 text-emerald-800'
                        }`}>{row.statusLabel}</span>
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-gray-50 font-semibold">
                    <td className="px-4 py-3">Total exposure</td>
                    <td className="px-4 py-3 text-right font-mono text-xs">{fmtUsd(report.taxLiabilities.totalAssessed)}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs">{fmtUsd(report.taxLiabilities.totalPaid)}</td>
                    <td className={`px-4 py-3 text-right font-mono ${report.taxLiabilities.totalBalance > 0 ? 'font-bold text-red-700 text-base' : 'text-gray-400'}`}>
                      {report.taxLiabilities.totalBalance > 0 ? fmtUsd(report.taxLiabilities.totalBalance) : '—'}
                    </td>
                    <td className={`px-4 py-3 text-right font-mono text-xs ${report.taxLiabilities.totalAccrued > 0 ? 'text-amber-700' : 'text-gray-400'}`}>
                      {report.taxLiabilities.totalAccrued > 0 ? fmtUsd(report.taxLiabilities.totalAccrued) : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">{report.taxLiabilities.totalAccrued > 0 ? 'includes accruing interest' : ''}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-gray-500 mt-3 italic">
            Sourced from Account Balance + TC 196 (interest) + TC 276 (failure-to-pay penalty) on each transcript.
          </p>
        </section>

        {/* Section 2.5: Income Reconciliation (Enterprise Bank / Derek Le 2026-05-11) */}
        {renderIncomeReconciliation(entity.income_baseline, entity.income_snapshot)}

        {/* Section 3: Repayment Plan */}
        <section className="bg-white rounded-lg shadow border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-bold text-mt-dark mb-4 pb-2 border-b border-gray-200">
            Repayment Plan Status
          </h2>
          <div className={`border-l-4 rounded-r p-5 ${
            report.repaymentPlan.hasInstallmentAgreement || report.repaymentPlan.hasOfferInCompromise || report.repaymentPlan.hasCurrentlyNotCollectible
              ? 'bg-blue-50 border-blue-500'
              : report.taxLiabilities.totalBalance > 0
                ? 'bg-amber-50 border-amber-500'
                : 'bg-emerald-50 border-emerald-500'
          }`}>
            <p className="text-base font-bold mb-1">
              {report.repaymentPlan.hasInstallmentAgreement && '✓ Active installment agreement on file'}
              {!report.repaymentPlan.hasInstallmentAgreement && report.repaymentPlan.hasOfferInCompromise && '◐ Offer in Compromise pending'}
              {!report.repaymentPlan.hasInstallmentAgreement && !report.repaymentPlan.hasOfferInCompromise && report.repaymentPlan.hasCurrentlyNotCollectible && '◐ Currently Not Collectible status'}
              {!report.repaymentPlan.hasInstallmentAgreement && !report.repaymentPlan.hasOfferInCompromise && !report.repaymentPlan.hasCurrentlyNotCollectible && report.taxLiabilities.totalBalance > 0 && '⚠ No active repayment plan on file'}
              {!report.repaymentPlan.hasInstallmentAgreement && !report.repaymentPlan.hasOfferInCompromise && !report.repaymentPlan.hasCurrentlyNotCollectible && report.taxLiabilities.totalBalance === 0 && '✓ No outstanding balance — no plan required'}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4 text-xs">
              <div className="bg-white border border-gray-200 rounded p-3">
                <p className="font-bold">Installment Agreement</p>
                <p className="text-gray-600 mt-1">
                  {report.repaymentPlan.hasInstallmentAgreement ? 'Active per TC 971 / 480 codes.' : 'Not on file.'}
                </p>
              </div>
              <div className="bg-white border border-gray-200 rounded p-3">
                <p className="font-bold">Offer in Compromise</p>
                <p className="text-gray-600 mt-1">
                  {report.repaymentPlan.hasOfferInCompromise ? 'Active per TC 480 / 481 codes.' : 'Not on file.'}
                </p>
              </div>
              <div className="bg-white border border-gray-200 rounded p-3">
                <p className="font-bold">Currently Not Collectible</p>
                <p className="text-gray-600 mt-1">
                  {report.repaymentPlan.hasCurrentlyNotCollectible ? 'Active per TC 530 code.' : 'Not on file.'}
                </p>
              </div>
            </div>
            {report.repaymentPlan.details.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-600 mb-1">Detected events</p>
                <ul className="text-xs text-gray-700 list-disc list-inside space-y-0.5">
                  {report.repaymentPlan.details.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
              </div>
            )}
            <p className="text-sm mt-4"><strong>Recommended path:</strong> {report.repaymentPlan.recommendation}</p>
          </div>
          <p className="text-xs text-gray-500 mt-3 italic">
            Sourced from full transaction-code scan for TC 480 / 481 / 482 / 520 / 530 / 971-with-installment codes.
          </p>
        </section>

        {/* Footnote */}
        <div className="text-xs text-gray-500 space-y-2 pb-8">
          <p>
            <strong>Generated:</strong> {new Date(report.generatedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })} from{' '}
            {report.sources.length} source file{report.sources.length === 1 ? '' : 's'}: {report.sources.join(', ')}.
          </p>
          <p>
            <strong>Not professional tax advice.</strong> Verify with the borrower&apos;s tax professional before any underwriting decision.
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Income Reconciliation section renderer
// ---------------------------------------------------------------------------

function renderIncomeReconciliation(
  baseline: IncomeSnapshot | null,
  current: IncomeSnapshot | null,
) {
  const fmtUsd = (n: number | null) =>
    typeof n === 'number'
      ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : '—';
  const fmtPct = (p: number | null) =>
    typeof p === 'number'
      ? `${p > 0 ? '+' : ''}${(p * 100).toFixed(1)}%`
      : '—';
  const fieldLabel = (f: string) =>
    f === 'grossReceipts' ? 'Gross receipts' :
    f === 'totalIncome' ? 'Total income' :
    f === 'totalTax' ? 'Total tax' :
    f === 'agi' ? 'AGI' : f;

  // Case A: no snapshot — entity hasn't been processed by the income hook yet.
  if (!current) {
    return (
      <section className="bg-white rounded-lg shadow border border-gray-200 p-6 mb-6">
        <h2 className="text-lg font-bold text-mt-dark mb-2 pb-2 border-b border-gray-200">
          Income Reconciliation
        </h2>
        <p className="text-sm text-gray-500 italic">
          Income figures haven&apos;t been captured for this entity yet. Will populate
          automatically on the next transcript completion.
        </p>
      </section>
    );
  }

  // Case B: first pull — baseline just established.
  const isFirstPull = baseline && JSON.stringify(baseline) === JSON.stringify(current);
  if (!baseline || isFirstPull) {
    return (
      <section className="bg-white rounded-lg shadow border border-gray-200 p-6 mb-6">
        <h2 className="text-lg font-bold text-mt-dark mb-4 pb-2 border-b border-gray-200">
          Income Reconciliation
        </h2>
        <div className="bg-emerald-50 border-l-4 border-emerald-500 rounded-r p-4 mb-4">
          <p className="text-base font-bold text-emerald-900">✓ Baseline established</p>
          <p className="text-sm text-emerald-800 mt-1">
            Income figures from this entity&apos;s {current.taxYear} return are now the reconciliation baseline.
            Subsequent monitoring pulls will be compared against these numbers.
          </p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <BaselineCell label="Gross receipts" value={fmtUsd(current.grossReceipts)} />
          <BaselineCell label="Total income" value={fmtUsd(current.totalIncome)} />
          <BaselineCell label="Total tax" value={fmtUsd(current.totalTax)} />
          <BaselineCell label="AGI" value={fmtUsd(current.agi)} />
        </div>
        <p className="text-xs text-gray-500 mt-3 italic">
          Source: {current.source}, captured {current.capturedAt.slice(0, 10)}.
        </p>
      </section>
    );
  }

  // Case C: variance available — compare and surface.
  const variance = compareIncomeSnapshots(baseline, current);
  const sevColor = (s: string) =>
    s === 'MATERIAL' ? 'bg-red-50 border-red-300 text-red-800' :
    s === 'WARNING' ? 'bg-amber-50 border-amber-300 text-amber-900' :
    'bg-gray-50 border-gray-200 text-gray-700';
  const headerColor =
    variance.overallSeverity === 'MATERIAL' ? 'bg-red-50 border-red-500 text-red-900' :
    variance.overallSeverity === 'WARNING' ? 'bg-amber-50 border-amber-500 text-amber-900' :
    'bg-emerald-50 border-emerald-500 text-emerald-900';

  return (
    <section className="bg-white rounded-lg shadow border border-gray-200 p-6 mb-6">
      <h2 className="text-lg font-bold text-mt-dark mb-4 pb-2 border-b border-gray-200">
        Income Reconciliation
      </h2>
      <div className={`border-l-4 rounded-r p-4 mb-4 ${headerColor}`}>
        <p className="text-base font-bold">
          {variance.overallSeverity === 'MATERIAL' ? '⚠ Material variance vs. loan-approval baseline' :
           variance.overallSeverity === 'WARNING' ? '◐ Notable variance vs. baseline' :
           '✓ Within tolerance of baseline'}
        </p>
        <p className="text-sm mt-1">{variance.summary}</p>
      </div>
      <div className="overflow-x-auto border border-gray-200 rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-600">
            <tr>
              <th className="px-4 py-2 text-left">Field</th>
              <th className="px-4 py-2 text-right">Baseline ({baseline.taxYear})</th>
              <th className="px-4 py-2 text-right">Current ({current.taxYear})</th>
              <th className="px-4 py-2 text-right">Δ Absolute</th>
              <th className="px-4 py-2 text-right">Δ %</th>
              <th className="px-4 py-2 text-left">Severity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {variance.fields.map((f, i) => (
              <tr key={i}>
                <td className="px-4 py-2.5 font-semibold">{fieldLabel(f.field)}</td>
                <td className="px-4 py-2.5 text-right font-mono text-xs">{fmtUsd(f.baseline)}</td>
                <td className="px-4 py-2.5 text-right font-mono text-xs">{fmtUsd(f.current)}</td>
                <td className="px-4 py-2.5 text-right font-mono text-xs">{f.deltaAbsolute !== null ? fmtUsd(f.deltaAbsolute) : '—'}</td>
                <td className="px-4 py-2.5 text-right font-mono text-xs">{fmtPct(f.deltaPct)}</td>
                <td className="px-4 py-2.5">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold border ${sevColor(f.severity)}`}>{f.severity}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500 mt-3 italic">
        Baseline: {baseline.source}, captured {baseline.capturedAt.slice(0, 10)}. Current: {current.source}, captured {current.capturedAt.slice(0, 10)}.
        Severity bands: INFO ≤ 5%, WARNING 5–15%, MATERIAL &gt; 15%.
      </p>
    </section>
  );
}

function BaselineCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg p-3 border bg-gray-50 border-gray-200">
      <p className="text-[11px] uppercase tracking-wide text-gray-500 font-medium">{label}</p>
      <p className="text-base font-bold mt-1 text-mt-dark font-mono">{value}</p>
    </div>
  );
}
