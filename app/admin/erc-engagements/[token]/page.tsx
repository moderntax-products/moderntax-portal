/**
 * Admin: detail page for a single ERC recovery engagement.
 *
 * URL: /admin/erc-engagements/[token]
 *
 * Shows current state + full stage history + advance-to-next-stage UI.
 * Server-renders the engagement state; the AdvanceStageForm is client-side
 * and posts to /api/admin/erc-engagement/[token]/advance.
 */

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';
import { AdvanceStageForm } from '@/components/AdvanceStageForm';

export const dynamic = 'force-dynamic';

const STAGE_DEFS: { key: string; label: string }[] = [
  { key: 'engagement_created',        label: 'Engagement created' },
  { key: 'awaiting_payment',          label: 'Awaiting payment' },
  { key: 'awaiting_intake',           label: 'Awaiting intake' },
  { key: 'intake_complete',           label: 'Ready to file' },
  { key: 'irs_contact_in_progress',   label: 'On line with IRS' },
  { key: 'trace_filed',               label: 'Refund trace filed' },
  { key: 'irs_verifying',             label: 'IRS verifying' },
  { key: 'check_in_mail',             label: 'Checks in mail' },
  { key: 'check_received',            label: 'Checks received' },
];

export default async function AdminErcEngagementDetailPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (profile?.role !== 'admin') redirect('/');

  const admin = createAdminClient();
  const { data: entity } = await admin
    .from('request_entities')
    .select('id, entity_name, tid, signer_email, gross_receipts, requests(loan_number, submitter_email, clients(name))')
    .eq('gross_receipts->>erc_recovery_token', token)
    .maybeSingle() as { data: any };

  if (!entity) notFound();
  const recovery = entity.gross_receipts?.erc_recovery || {};
  const currentStageIdx = STAGE_DEFS.findIndex(s => s.key === recovery.current_stage);
  const nextStage = STAGE_DEFS[currentStageIdx + 1];

  const defaultEmail = entity.signer_email || entity.requests?.submitter_email || '';
  const merchantUrl = `https://portal.moderntax.io/erc-status/${token}`;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link href="/admin/erc-engagements" className="text-xs text-gray-500 hover:text-gray-700">← All engagements</Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-1">{entity.entity_name}</h1>
        <p className="text-sm text-gray-600 mt-1">
          {entity.requests?.clients?.name} · loan {entity.requests?.loan_number || '—'} · EIN {entity.tid}
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Merchant tracking page: <a href={merchantUrl} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline">{merchantUrl}</a>
        </p>

        {/* Working link: the per-quarter ERC report with recoverable detail +
            IRS filing guidance (Form 8822-B / reissuance line). This is what
            you actually work the recovery from. */}
        <div className="mt-3">
          <Link
            href={`/admin/erc-report/${entity.id}`}
            className="inline-flex items-center gap-2 rounded-lg bg-mt-dark px-4 py-2 text-sm font-semibold text-white hover:bg-opacity-90"
          >
            View ERC report &amp; filing instructions →
          </Link>
        </div>

        {/* Summary tiles */}
        <div className="grid grid-cols-3 gap-3 my-6">
          <div className="bg-white rounded border p-3">
            <div className="text-xs uppercase tracking-wide text-gray-500">Recoverable</div>
            <div className="text-lg font-bold text-emerald-700 mt-1">
              ${Number(recovery.total_recoverable || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
          <div className="bg-white rounded border p-3">
            <div className="text-xs uppercase tracking-wide text-gray-500">Quarters</div>
            <div className="text-lg font-bold text-gray-900 mt-1">{recovery.events?.length || 0}</div>
          </div>
          <div className="bg-white rounded border p-3">
            <div className="text-xs uppercase tracking-wide text-gray-500">Current stage</div>
            <div className="text-sm font-bold text-blue-900 mt-1">{STAGE_DEFS.find(s => s.key === recovery.current_stage)?.label || recovery.current_stage}</div>
          </div>
        </div>

        {/* Mailing address (if captured) */}
        {recovery.new_mailing_address && (
          <div className="bg-blue-50 border border-blue-200 rounded p-4 mb-6">
            <div className="text-xs font-semibold text-blue-900 uppercase tracking-wide mb-1">Mailing address for replacement checks</div>
            <div className="text-sm text-gray-900 whitespace-pre-line">
              {recovery.new_mailing_address.address1}
              {recovery.new_mailing_address.address2 && '\n' + recovery.new_mailing_address.address2}
              {'\n' + recovery.new_mailing_address.city + ', ' + recovery.new_mailing_address.state + ' ' + recovery.new_mailing_address.zip}
            </div>
          </div>
        )}

        {/* Quarters table */}
        {recovery.events && recovery.events.length > 0 && (
          <div className="bg-white rounded-lg border mb-6">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-600">
                <tr>
                  <th className="text-left px-4 py-2">Quarter</th>
                  <th className="text-left px-4 py-2">Form</th>
                  <th className="text-left px-4 py-2">Issued</th>
                  <th className="text-right px-4 py-2">Amount</th>
                  <th className="text-left px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {recovery.events.map((e: any, i: number) => (
                  <tr key={i}>
                    <td className="px-4 py-2 font-mono text-xs">{e.tax_quarter || e.period_ending}</td>
                    <td className="px-4 py-2 text-xs">{e.form_type || '941'}</td>
                    <td className="px-4 py-2 font-mono text-xs">{e.issued_on}</td>
                    <td className="px-4 py-2 text-right font-semibold">${Number(e.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                    <td className="px-4 py-2 text-xs">{e.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Stage advance form */}
        {nextStage && (
          <div className="bg-white rounded-lg border p-5 mb-6">
            <h2 className="text-base font-bold text-gray-900 mb-3">Advance to next stage</h2>
            <AdvanceStageForm
              token={token}
              nextStage={nextStage}
              defaultEmail={defaultEmail}
              hasMailingAddress={!!recovery.new_mailing_address}
            />
          </div>
        )}

        {/* Stage history */}
        <div className="bg-white rounded-lg border p-5">
          <h2 className="text-base font-bold text-gray-900 mb-3">Stage history</h2>
          {recovery.stage_history && recovery.stage_history.length > 0 ? (
            <ul className="space-y-3">
              {recovery.stage_history.slice().reverse().map((h: any, i: number) => (
                <li key={i} className="flex gap-3 text-sm">
                  <div className="text-xs text-gray-500 w-36 flex-shrink-0">
                    {new Date(h.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </div>
                  <div className="flex-1">
                    <div className="font-medium text-gray-900">{STAGE_DEFS.find(s => s.key === h.stage)?.label || h.stage}</div>
                    {h.merchant_visible_note && (
                      <div className="text-xs text-gray-700 mt-0.5">{h.merchant_visible_note}</div>
                    )}
                    {h.internal_note && (
                      <div className="text-xs text-gray-500 italic mt-0.5 bg-gray-50 p-1.5 rounded">Internal: {h.internal_note}</div>
                    )}
                    {h.actor && <div className="text-[10px] text-gray-400 mt-0.5">by {h.actor}</div>}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-500 italic">No stage history yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
