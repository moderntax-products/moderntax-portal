/**
 * Filing-Compliance Report (MOD-228 Phase 5).
 *
 * URL: /admin/filing-compliance-report/[entityId]
 *
 * Renders a per-year filing-status + civil-penalty report parsed from the
 * entity's IRS Account Transcripts (no income/wage data). Backed by
 * lib/filing-compliance.buildFilingComplianceReport.
 *
 * Access: admin always; manager/processor on their own client; assigned expert.
 * ⚠️ Parser needs validation against real account transcripts before being
 * exposed customer-facing — admin/internal use for now.
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';
import { TidReveal } from '@/components/TidReveal';
import { buildFilingComplianceReport } from '@/lib/filing-compliance';

export const dynamic = 'force-dynamic';

interface PageProps { params: Promise<{ entityId: string }> }

const fmtUsd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function FilingComplianceReportPage({ params }: PageProps) {
  const { entityId } = await params;

  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: profile } = await supabase
    .from('profiles').select('role, client_id').eq('id', user.id).single() as {
      data: { role: string; client_id: string | null } | null;
    };
  if (!profile) redirect('/');

  const admin = createAdminClient();
  const { data: entity } = await admin
    .from('request_entities')
    .select('id, entity_name, tid, tid_kind, form_type, years, status, transcript_urls, transcript_html_urls, request_id, requests(loan_number, client_id, clients(name))')
    .eq('id', entityId).single() as { data: any };

  if (!entity) {
    return <div className="max-w-3xl mx-auto p-8"><p>Entity not found.</p></div>;
  }

  // Access control (mirrors the ERC report page).
  const entityClientId = entity.requests?.client_id;
  let canView = profile.role === 'admin';
  if (!canView && ['manager', 'processor', 'team_member'].includes(profile.role)) {
    canView = !!entityClientId && entityClientId === profile.client_id;
  }
  if (!canView && profile.role === 'expert') {
    const { data: assn } = await admin.from('expert_assignments').select('id').eq('entity_id', entityId).limit(1).maybeSingle();
    canView = !!assn;
  }
  if (!canView) redirect('/');

  // Load every account-transcript HTML on file.
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

  const requestedYears: string[] = Array.isArray(entity.years) ? entity.years.map(String) : [];
  const report = buildFilingComplianceReport(entity.entity_name, entity.tid, transcripts, requestedYears);
  const clientName = entity.requests?.clients?.name || 'Unknown';

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link href={`/admin/requests/${entity.request_id}`} className="text-xs text-gray-500 hover:text-gray-700">← Back to request</Link>
        <h1 className="text-2xl sm:text-3xl font-bold text-mt-dark mt-1">Filing-Compliance Report</h1>
        <p className="text-sm text-gray-600 mt-1">
          {report.entityName} · {clientName} · EIN <TidReveal tid={entity.tid} kind={entity.tid_kind || 'EIN'} className="font-mono" />
          {' · '}civil penalties + filed/unfiled status · from {transcripts.length} account transcript{transcripts.length === 1 ? '' : 's'} on file
        </p>

        {transcripts.length === 0 && (
          <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            No account transcripts are on file for this entity yet. Once the expert pulls the Account Transcript(s), this report will populate.
          </div>
        )}

        {/* Summary tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 my-6">
          <Tile label="Years covered" value={String(report.summary.yearsCovered)} />
          <Tile label="Filed" value={String(report.summary.yearsFiled)} tone="green" />
          <Tile label="Unfiled" value={String(report.summary.yearsUnfiled)} tone={report.summary.yearsUnfiled > 0 ? 'red' : 'gray'} />
          <Tile label="Civil penalties" value={fmtUsd(report.summary.totalPenalties)} tone={report.summary.totalPenalties > 0 ? 'red' : 'gray'} />
        </div>

        {/* Per-year table */}
        <div className="bg-white rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-600">
              <tr>
                <th className="text-left px-4 py-2">Year</th>
                <th className="text-left px-4 py-2">Form</th>
                <th className="text-left px-4 py-2">Return filed?</th>
                <th className="text-left px-4 py-2">Civil penalties</th>
                <th className="text-right px-4 py-2">Penalty $</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {report.periods.map((p) => (
                <tr key={p.year}>
                  <td className="px-4 py-2 font-mono text-xs">{p.year || '—'}</td>
                  <td className="px-4 py-2 text-xs">{p.formNumber || entity.form_type || '—'}</td>
                  <td className="px-4 py-2 text-xs">
                    {p.source === 'NO_TRANSCRIPT_ON_FILE' ? (
                      <span className="text-purple-700">No transcript pulled</span>
                    ) : p.returnFiled ? (
                      <span className="text-emerald-700 font-medium">Filed{p.returnFiledDate ? ` (${p.returnFiledDate})` : ''}</span>
                    ) : (
                      <span className="text-red-700 font-medium">No return posted</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-700">
                    {p.penalties.length === 0
                      ? (p.source === 'NO_TRANSCRIPT_ON_FILE' ? '—' : 'None')
                      : p.penalties.map((t) => `TC ${t.code} ${t.explanation}`).join('; ')}
                  </td>
                  <td className="px-4 py-2 text-right font-semibold">{p.totalPenalties > 0 ? fmtUsd(p.totalPenalties) : '—'}</td>
                </tr>
              ))}
              {report.periods.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400 text-sm">Nothing to report yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-[11px] text-gray-400">
          <strong>How this is generated:</strong> parsed directly from the IRS Account Transcript transaction codes on file
          (TC 150 = return filed; TC 160/166/170/176/234/238/240/246/270/276/280/320/350 = civil-penalty assessments).
          No income or wage data is used. Verify against the source transcript before relying on it for credit decisions.
        </p>
      </div>
    </div>
  );
}

function Tile({ label, value, tone = 'gray' }: { label: string; value: string; tone?: 'gray' | 'green' | 'red' }) {
  const color = tone === 'green' ? 'text-emerald-700' : tone === 'red' ? 'text-red-700' : 'text-gray-900';
  return (
    <div className="bg-white rounded border p-3">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-lg font-bold mt-1 ${color}`}>{value}</div>
    </div>
  );
}
