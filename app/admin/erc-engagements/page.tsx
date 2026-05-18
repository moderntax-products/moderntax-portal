/**
 * Admin: list of all ERC recovery engagements.
 *
 * Pulls every entity with gross_receipts.erc_recovery_token set, shows
 * current stage + amount + last activity, click-through to detail page.
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

const STAGE_LABEL: Record<string, string> = {
  engagement_created:        'Engagement created',
  awaiting_payment:          'Awaiting payment',
  awaiting_intake:           'Awaiting intake',
  intake_complete:           'Ready to file',
  irs_contact_in_progress:   'On line with IRS',
  trace_filed:               'Refund trace filed',
  irs_verifying:             'IRS verifying',
  check_in_mail:             'Checks in mail',
  check_received:            'Checks received',
};

const STAGE_COLOR: Record<string, string> = {
  engagement_created:        'bg-gray-100 text-gray-800',
  awaiting_payment:          'bg-amber-100 text-amber-900',
  awaiting_intake:           'bg-amber-100 text-amber-900',
  intake_complete:           'bg-blue-100 text-blue-900',
  irs_contact_in_progress:   'bg-blue-200 text-blue-900',
  trace_filed:               'bg-indigo-100 text-indigo-900',
  irs_verifying:             'bg-indigo-100 text-indigo-900',
  check_in_mail:             'bg-emerald-100 text-emerald-900',
  check_received:            'bg-emerald-200 text-emerald-900',
};

export default async function AdminErcEngagementsPage() {
  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (profile?.role !== 'admin') redirect('/');

  const admin = createAdminClient();
  const { data: entities } = await admin
    .from('request_entities')
    .select('id, entity_name, gross_receipts, requests(loan_number, clients(name))')
    .not('gross_receipts->>erc_recovery_token', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(100) as { data: any[] | null };

  const rows = (entities || []).map(e => {
    const rec = e.gross_receipts?.erc_recovery || {};
    const token = e.gross_receipts?.erc_recovery_token;
    return {
      entityId: e.id,
      entityName: e.entity_name,
      clientName: e.requests?.clients?.name || '—',
      loanNumber: e.requests?.loan_number || null,
      token,
      currentStage: rec.current_stage || 'engagement_created',
      totalRecoverable: rec.total_recoverable || 0,
      eventCount: rec.events?.length || 0,
      lastActivityAt: rec.stage_history?.slice(-1)?.[0]?.at || rec.engagement_created_at,
      invoicePaid: !!rec.invoice?.pay_url, // crude — TODO link to mercury_invoices.paid
    };
  });

  const summary = {
    total: rows.length,
    active: rows.filter(r => !['check_received', 'closed'].includes(r.currentStage)).length,
    awaiting_irs: rows.filter(r => ['irs_contact_in_progress', 'trace_filed', 'irs_verifying'].includes(r.currentStage)).length,
    completed: rows.filter(r => r.currentStage === 'check_received').length,
    totalRecoverable: rows.reduce((s, r) => s + Number(r.totalRecoverable || 0), 0),
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link href="/admin" className="text-xs text-gray-500 hover:text-gray-700">← Admin</Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-1 mb-6">ERC Recovery Engagements</h1>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          <Kpi label="Total" value={summary.total.toString()} />
          <Kpi label="Active" value={summary.active.toString()} color="amber" />
          <Kpi label="Awaiting IRS" value={summary.awaiting_irs.toString()} color="blue" />
          <Kpi label="Completed" value={summary.completed.toString()} color="emerald" />
          <Kpi label="Total recoverable" value={summary.totalRecoverable.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} color="emerald" highlight />
        </div>

        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-600">
              <tr>
                <th className="px-4 py-2 text-left">Entity</th>
                <th className="px-4 py-2 text-left">Client</th>
                <th className="px-4 py-2 text-right">Recoverable</th>
                <th className="px-4 py-2 text-left">Stage</th>
                <th className="px-4 py-2 text-left">Last activity</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500 italic">No ERC recovery engagements yet.</td></tr>
              ) : rows.map(r => (
                <tr key={r.entityId} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium">{r.entityName}</td>
                  <td className="px-4 py-2 text-gray-600">{r.clientName} {r.loanNumber && <span className="text-xs text-gray-400">· loan {r.loanNumber}</span>}</td>
                  <td className="px-4 py-2 text-right font-mono">${Number(r.totalRecoverable).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td className="px-4 py-2">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded ${STAGE_COLOR[r.currentStage] || 'bg-gray-100 text-gray-700'}`}>
                      {STAGE_LABEL[r.currentStage] || r.currentStage}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">
                    {r.lastActivityAt ? new Date(r.lastActivityAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Link href={`/admin/erc-engagements/${r.token}`} className="text-blue-700 hover:text-blue-900 font-medium text-sm">
                      Manage →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, color = 'gray', highlight = false }: { label: string; value: string; color?: 'gray' | 'amber' | 'blue' | 'emerald'; highlight?: boolean }) {
  const cls = {
    gray: 'bg-white border-gray-200 text-gray-900',
    amber: 'bg-amber-50 border-amber-200 text-amber-900',
    blue: 'bg-blue-50 border-blue-200 text-blue-900',
    emerald: highlight ? 'bg-emerald-100 border-emerald-300 text-emerald-900' : 'bg-emerald-50 border-emerald-200 text-emerald-900',
  }[color];
  return (
    <div className={`rounded-lg border p-3 ${cls}`}>
      <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">{label}</div>
      <div className="text-lg font-bold mt-0.5">{value}</div>
    </div>
  );
}
