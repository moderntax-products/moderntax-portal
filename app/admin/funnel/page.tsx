/**
 * /admin/funnel — Trial-to-paid conversion analytics.
 * Shows conversion funnel + hot trials list.
 */

import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

function pct(n: number, d: number) {
  if (!d) return '—';
  return Math.round((n / d) * 100) + '%';
}

export default async function FunnelPage() {
  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single() as { data: any };
  if (profile?.role !== 'admin') redirect('/');

  let funnelData = { signed_up: 0, first_pull: 0, converted: 0, invoice_paid: 0 };
  let hotTrials: any[] = [];
  let migrationPending = false;

  try {
    const admin = await createServerComponentClient();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: approvedClients, error: tableErr } = await (admin.from('trial_funnel_events') as any)
      .select('client_id').eq('event_type', 'signup_approved').gte('created_at', thirtyDaysAgo.toISOString());

    if (tableErr && /trial_funnel_events|does not exist/i.test(tableErr.message || '')) {
      migrationPending = true;
    } else if (approvedClients?.length) {
      const clientIds = [...new Set((approvedClients as any[]).map((r: any) => r.client_id))];
      funnelData.signed_up = clientIds.length;

      const getCount = async (evt: string) => {
        const { data } = await (admin.from('trial_funnel_events') as any).select('client_id').eq('event_type', evt).in('client_id', clientIds);
        return new Set((data || []).map((r: any) => r.client_id)).size;
      };
      funnelData.first_pull = await getCount('pull_completed');
      funnelData.converted = await getCount('trial_converted');
      funnelData.invoice_paid = await getCount('invoice_paid');
    }

    // Hot trials
    if (!migrationPending) {
      const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const { data: recentPulls } = await (admin.from('trial_funnel_events') as any)
        .select('client_id').eq('event_type', 'pull_completed').gte('created_at', sevenDaysAgo.toISOString());

      if (recentPulls?.length) {
        const pulledIds = [...new Set((recentPulls as any[]).map((r: any) => r.client_id))];
        const { data: conv } = await (admin.from('trial_funnel_events') as any).select('client_id').eq('event_type', 'trial_converted').in('client_id', pulledIds);
        const { data: card } = await (admin.from('trial_funnel_events') as any).select('client_id').eq('event_type', 'card_captured').in('client_id', pulledIds);
        const excl = new Set([...(conv || []), ...(card || [])].map((r: any) => r.client_id));
        const hotIds = pulledIds.filter(id => !excl.has(id));

        if (hotIds.length) {
          const { data: clients } = await admin.from('clients').select('id, name').in('id', hotIds);
          const { data: managers } = await admin.from('profiles').select('client_id, email, full_name').in('client_id', hotIds).eq('role', 'manager');
          hotTrials = (clients || []).map((c: any) => ({
            ...c,
            manager_email: (managers || []).find((p: any) => p.client_id === c.id)?.email,
            manager_name: (managers || []).find((p: any) => p.client_id === c.id)?.full_name,
          }));
        }
      }
    }
  } catch { migrationPending = true; }

  const stages = [
    { label: 'Approved (30d)', count: funnelData.signed_up, drop: null },
    { label: 'First pull', count: funnelData.first_pull, drop: pct(funnelData.signed_up - funnelData.first_pull, funnelData.signed_up) },
    { label: 'Converted', count: funnelData.converted, drop: pct(funnelData.first_pull - funnelData.converted, funnelData.first_pull) },
    { label: 'Invoice paid', count: funnelData.invoice_paid, drop: pct(funnelData.converted - funnelData.invoice_paid, funnelData.converted) },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center gap-4 mb-8">
          <Link href="/admin" className="text-gray-400 hover:text-gray-600">← Admin</Link>
          <h1 className="text-2xl font-bold text-mt-dark">Trial Funnel Analytics</h1>
        </div>

        {migrationPending && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 text-sm text-amber-800">
            Paste <code className="font-mono text-xs">supabase/migration-trial-funnel-events.sql</code> in Studio to enable funnel tracking.
          </div>
        )}

        <div className="bg-white rounded-lg shadow p-6 mb-8">
          <h2 className="text-lg font-semibold text-mt-dark mb-6">Conversion funnel — last 30 days</h2>
          <div className="grid grid-cols-4 gap-4">
            {stages.map((s, i) => (
              <div key={i} className="text-center">
                <div className="text-3xl font-bold text-mt-dark">{s.count}</div>
                <div className="text-sm text-gray-600 mt-1">{s.label}</div>
                {s.drop && <div className="text-xs text-red-500 mt-1">{s.drop} drop</div>}
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-mt-dark mb-1">Hot trials</h2>
          <p className="text-sm text-gray-500 mb-4">Pulled in last 7 days, no card yet, not converted.</p>
          {hotTrials.length === 0 ? (
            <p className="text-sm text-gray-400 italic">No hot trials right now.</p>
          ) : (
            <table className="w-full">
              <thead className="border-b border-gray-200">
                <tr className="text-left text-xs text-gray-500 uppercase tracking-wide">
                  <th className="pb-2">Company</th>
                  <th className="pb-2">Manager</th>
                  <th className="pb-2">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {hotTrials.map((t: any) => (
                  <tr key={t.id}>
                    <td className="py-3 font-medium text-mt-dark">{t.name}</td>
                    <td className="py-3 text-sm text-gray-600">{t.manager_name || t.manager_email || '—'}</td>
                    <td className="py-3">
                      {t.manager_email && (
                        <a href={`mailto:${t.manager_email}?subject=Your%20ModernTax%20trial&body=Hi%20${encodeURIComponent(t.manager_name || '')}%2C%0A%0AYou%20recently%20ran%20your%20first%20transcript%20on%20ModernTax.%20Wanted%20to%20check%20in%20and%20see%20if%20you%20had%20any%20questions.%0A%0A%E2%80%94%20Matt`}
                          className="text-xs px-3 py-1.5 bg-mt-green text-white rounded-lg font-medium hover:bg-opacity-90">
                          Follow up →
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
