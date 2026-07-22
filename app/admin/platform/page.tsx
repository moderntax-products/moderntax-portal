/**
 * Admin → Platform Visibility
 *
 * Every ordering user on the platform and whether they can actually order,
 * answered by running the real checkOrderGate(). Blocked users sort to the
 * top because they're defects, not prospects.
 *
 * Built 2026-07-22 after five people turned out to be blocked by our own
 * bugs rather than uninterested — see lib/platform-visibility.ts for the
 * full list. Nothing in the admin surfaced any of them.
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';
import { getPlatformVisibility } from '@/lib/platform-visibility';

export const dynamic = 'force-dynamic';

export default async function PlatformVisibilityPage() {
  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: adminProfile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (!adminProfile || adminProfile.role !== 'admin') redirect('/');

  const admin = createAdminClient();
  const { rows, summary } = await getPlatformVisibility(admin);

  const blocked = rows.filter((r) => !r.canOrder && !r.isInternal);
  const active = rows.filter((r) => r.canOrder && !r.isInternal);
  const internal = rows.filter((r) => r.isInternal);

  const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-6">
          <Link href="/admin" className="text-sm text-gray-500 hover:text-mt-dark">&larr; Admin</Link>
          <h1 className="text-2xl font-bold text-mt-dark mt-2">Platform Visibility</h1>
          <p className="text-sm text-gray-600 mt-1">
            Every ordering user, and whether they can actually place an order right now.
            Blocked users are checked against the same order gate the intake routes use &mdash;
            these are defects to fix, not people to email.
          </p>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
          {[
            { label: 'Ordering users', value: summary.total, tone: 'text-mt-dark' },
            { label: 'Can order', value: summary.canOrder, tone: 'text-green-600' },
            { label: 'BLOCKED', value: summary.blocked, tone: summary.blocked > 0 ? 'text-red-600' : 'text-gray-400' },
            { label: 'Never ordered', value: summary.neverOrdered, tone: 'text-amber-600' },
            { label: 'Blocked + never ordered', value: summary.blockedAndNeverOrdered, tone: summary.blockedAndNeverOrdered > 0 ? 'text-red-600' : 'text-gray-400' },
          ].map((c) => (
            <div key={c.label} className="bg-white rounded-lg border border-gray-200 p-4">
              <div className={`text-2xl font-bold ${c.tone}`}>{c.value}</div>
              <div className="text-xs text-gray-500 mt-1">{c.label}</div>
            </div>
          ))}
        </div>

        {/* Blocked — the actionable list */}
        <section className="mb-10">
          <h2 className="text-lg font-semibold text-mt-dark mb-1">
            Blocked {blocked.length > 0 && <span className="text-red-600">({blocked.length})</span>}
          </h2>
          <p className="text-xs text-gray-500 mb-3">
            These people cannot place an order. Each line is a bug with a name attached.
          </p>
          {blocked.length === 0 ? (
            <div className="bg-white rounded-lg border border-gray-200 p-6 text-sm text-gray-500">
              Nobody is blocked. Every ordering user can place an order right now.
            </div>
          ) : (
            <div className="bg-white rounded-lg border border-red-200 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-red-50 text-left">
                  <tr className="text-xs uppercase tracking-wide text-red-700">
                    <th className="px-4 py-2 font-semibold">User</th>
                    <th className="px-4 py-2 font-semibold">Client</th>
                    <th className="px-4 py-2 font-semibold">Why they&apos;re blocked</th>
                    <th className="px-4 py-2 font-semibold text-right">Orders</th>
                    <th className="px-4 py-2 font-semibold text-right">Age</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {blocked.map((r) => (
                    <tr key={r.id} className="hover:bg-red-50/40">
                      <td className="px-4 py-3">
                        <div className="font-medium text-mt-dark">{r.full_name || '—'}</div>
                        <div className="text-xs text-gray-500 font-mono">{r.email}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-700">{r.client_name || <span className="text-red-600 font-medium">none</span>}</td>
                      <td className="px-4 py-3">
                        <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-red-100 text-red-700 mb-1">{r.blocker}</span>
                        <div className="text-xs text-gray-600">{r.blockerDetail}</div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-700">{r.orderCount}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-500">{r.daysSinceSignup}d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Everyone who can order */}
        <section className="mb-10">
          <h2 className="text-lg font-semibold text-mt-dark mb-1">Can order ({active.length})</h2>
          <p className="text-xs text-gray-500 mb-3">
            Zero-order users here are a genuine activation question &mdash; the product isn&apos;t stopping them.
          </p>
          <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left">
                <tr className="text-xs uppercase tracking-wide text-gray-500">
                  <th className="px-4 py-2 font-semibold">User</th>
                  <th className="px-4 py-2 font-semibold">Client</th>
                  <th className="px-4 py-2 font-semibold">Role</th>
                  <th className="px-4 py-2 font-semibold text-right">Orders</th>
                  <th className="px-4 py-2 font-semibold">Last order</th>
                  <th className="px-4 py-2 font-semibold text-right">Age</th>
                  <th className="px-4 py-2 font-semibold">Notifications</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {active.map((r) => (
                  <tr key={r.id} className={r.orderCount === 0 ? 'bg-amber-50/50' : ''}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-mt-dark">{r.full_name || '—'}</div>
                      <div className="text-xs text-gray-500 font-mono">{r.email}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-700">{r.client_name || '—'}</td>
                    <td className="px-4 py-3 text-gray-600">{r.role}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {r.orderCount === 0
                        ? <span className="text-amber-700 font-semibold">0</span>
                        : <span className="text-mt-dark font-medium">{r.orderCount}</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{fmtDate(r.lastOrderAt)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-500">{r.daysSinceSignup}d</td>
                    <td className="px-4 py-3">
                      {r.notificationsPaused
                        ? <span className="text-xs text-gray-500">paused</span>
                        : <span className="text-xs text-gray-400">on</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {internal.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-500 mb-2">Internal / demo ({internal.length})</h2>
            <div className="bg-white rounded-lg border border-gray-200 p-4 text-xs text-gray-500">
              {internal.map((r) => r.email).join(' · ')}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
