/**
 * Email engagement ranking — sales triage view
 *
 * URL: /admin/email-engagement
 *
 * Queries the `email_engagement_summary` materialized view (populated
 * by the SendGrid Event Webhook) and ranks recipients by engagement
 * score (clicks×3 + opens). The view is refreshed by a cron sweep
 * (added to vercel.json in the same commit).
 *
 * Source: supabase/migration-sendgrid-events.sql
 */

import { redirect } from 'next/navigation';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';
import Link from 'next/link';

interface EngagementRow {
  email: string;
  opens: number;
  unique_opens: number;
  clicks: number;
  unique_clicks: number;
  delivered: number;
  bounces: number;
  spam_reports: number;
  unsubscribes: number;
  score: number;
  first_event_at: string | null;
  last_event_at: string | null;
  categories: string[] | null;
}

interface SearchParams {
  category?: string;
  min_clicks?: string;
  since?: string;
}

export default async function EmailEngagementPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { category, min_clicks, since } = await searchParams;
  const supabase = await createServerComponentClient();

  // Admin gate — mirrors app/admin/page.tsx
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null };
  if (!profile || profile.role !== 'admin') redirect('/');

  // Use the admin client for the engagement view because the table is
  // populated by service-role inserts and isn't readable by the
  // session role.
  const admin = createAdminClient();

  // Refresh-on-view: the materialized view is also refreshed on a 3x-
  // daily cron, but admins typically look at this page after sending
  // a campaign and want the freshest possible data. The refresh is
  // CONCURRENTLY so this is cheap (hundreds of ms even at 100k events)
  // and doesn't block readers. Best-effort — failures don't block render.
  try {
    await (admin as any).rpc('refresh_email_engagement_summary');
  } catch (refreshErr) {
    console.warn('[email-engagement] refresh-on-view failed (showing stale data):', refreshErr);
  }

  // Build the query off the materialized view. Filter by category by
  // intersecting the GIN-indexed categories array.
  let query = (admin.from('email_engagement_summary' as any) as any)
    .select('*')
    .order('score', { ascending: false })
    .limit(200);

  if (category) {
    // Postgres array contains: column @> ARRAY[value]
    query = query.contains('categories', [category]);
  }
  if (min_clicks) {
    const n = parseInt(min_clicks, 10);
    if (Number.isFinite(n)) query = query.gte('clicks', n);
  }
  if (since) {
    query = query.gte('last_event_at', since);
  }

  const { data: rows, error } = await query as { data: EngagementRow[] | null; error: any };

  // Count totals for the header summary independently of the row LIMIT.
  const { count: totalRecipients } = await (admin
    .from('email_engagement_summary' as any) as any)
    .select('*', { count: 'exact', head: true });

  // Recent campaign categories — pull distinct from a small sample
  // to populate the filter dropdown. Cheap enough to do at request time.
  const { data: catSample } = await (admin
    .from('email_engagement_summary' as any) as any)
    .select('categories')
    .limit(500);
  const allCats = new Set<string>();
  (catSample || []).forEach((r: any) => (r.categories || []).forEach((c: string) => allCats.add(c)));
  const categories = Array.from(allCats).sort();

  if (error) {
    return (
      <div className="max-w-5xl mx-auto p-8">
        <h1 className="text-2xl font-bold text-mt-dark">Email engagement</h1>
        <div className="mt-6 bg-amber-50 border border-amber-200 rounded p-4">
          <p className="text-sm font-semibold text-amber-900">
            The engagement table isn&apos;t populated yet.
          </p>
          <p className="text-sm text-amber-800 mt-2">
            Two things have to happen first:
          </p>
          <ol className="list-decimal pl-6 mt-2 text-sm text-amber-800 space-y-1">
            <li>Run <code className="bg-amber-100 px-1 rounded">supabase/migration-sendgrid-events.sql</code> on Supabase.</li>
            <li>
              In SendGrid → Settings → Mail Settings → Event Webhook, set the
              URL to <code className="bg-amber-100 px-1 rounded">https://portal.moderntax.io/api/webhook/sendgrid-events</code>,
              enable signature verification, and paste the public key into
              the <code className="bg-amber-100 px-1 rounded">SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY</code> Vercel env var.
            </li>
          </ol>
          <p className="text-sm text-amber-800 mt-3">
            After both, send one test email; events should populate within seconds.
          </p>
        </div>
        <div className="mt-4 text-xs text-gray-500">
          Error detail: {error.message}
        </div>
      </div>
    );
  }

  const recipients = rows || [];
  const clickHeavy = recipients.filter(r => r.clicks >= 2 && r.unsubscribes === 0 && r.spam_reports === 0);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <Link href="/admin" className="text-xs text-gray-500 hover:text-gray-700">
              ← Admin
            </Link>
            <h1 className="text-2xl sm:text-3xl font-bold text-mt-dark mt-1">
              Email engagement
            </h1>
            <p className="text-gray-600 text-sm mt-1">
              {totalRecipients ?? recipients.length} recipients with at least one tracked event.
              Score = clicks×3 + opens.
            </p>
          </div>
          <form className="flex items-center gap-2 text-sm">
            <select
              name="category"
              defaultValue={category || ''}
              className="border border-gray-300 rounded px-3 py-1.5 bg-white"
            >
              <option value="">All campaigns</option>
              {categories.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <input
              type="number"
              name="min_clicks"
              defaultValue={min_clicks || ''}
              placeholder="Min clicks"
              className="border border-gray-300 rounded px-3 py-1.5 w-28"
              min={0}
            />
            <button
              type="submit"
              className="px-3 py-1.5 bg-mt-dark text-white rounded hover:bg-mt-navy"
            >
              Filter
            </button>
          </form>
        </div>

        {/* Hot-leads callout — click-heavy contacts get prominent treatment */}
        {clickHeavy.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-5 mb-8">
            <h2 className="text-base font-bold text-red-800 flex items-center gap-2">
              <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></span>
              {clickHeavy.length} hot lead{clickHeavy.length === 1 ? '' : 's'} (≥2 clicks, no unsub/spam)
            </h2>
            <ul className="mt-3 space-y-1 text-sm">
              {clickHeavy.slice(0, 10).map(r => (
                <li key={r.email} className="flex items-baseline gap-3">
                  <span className="font-mono text-xs text-red-700 w-12 text-right">{r.clicks}c</span>
                  <span className="font-mono text-xs text-gray-500 w-12 text-right">{r.opens}o</span>
                  <a
                    href={`mailto:${r.email}`}
                    className="text-mt-dark hover:text-mt-green font-medium"
                  >
                    {r.email}
                  </a>
                  {r.last_event_at && (
                    <span className="text-xs text-gray-400 ml-auto">
                      last {new Date(r.last_event_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Full table */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-600">
              <tr>
                <th className="px-4 py-2 text-left">Rank</th>
                <th className="px-4 py-2 text-left">Recipient</th>
                <th className="px-4 py-2 text-right">Score</th>
                <th className="px-4 py-2 text-right">Clicks</th>
                <th className="px-4 py-2 text-right">Opens</th>
                <th className="px-4 py-2 text-right">Delivered</th>
                <th className="px-4 py-2 text-right">Bounces</th>
                <th className="px-4 py-2 text-right">Unsub</th>
                <th className="px-4 py-2 text-left">Last event</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {recipients.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                    No engagement events yet matching these filters.
                  </td>
                </tr>
              ) : (
                recipients.map((r, i) => (
                  <tr key={r.email} className={`hover:bg-gray-50 ${r.unsubscribes > 0 || r.spam_reports > 0 ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-2 text-gray-500 font-mono text-xs">{i + 1}</td>
                    <td className="px-4 py-2">
                      <a href={`mailto:${r.email}`} className="font-medium text-mt-dark hover:text-mt-green">
                        {r.email}
                      </a>
                      {r.unsubscribes > 0 && (
                        <span className="ml-2 text-xs text-gray-400">unsubscribed</span>
                      )}
                      {r.spam_reports > 0 && (
                        <span className="ml-2 text-xs text-red-600 font-semibold">SPAM</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right font-mono font-bold">{r.score}</td>
                    <td className={`px-4 py-2 text-right font-mono ${r.clicks > 0 ? 'text-mt-green font-semibold' : 'text-gray-400'}`}>
                      {r.clicks}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-700">{r.opens}</td>
                    <td className="px-4 py-2 text-right text-gray-600">{r.delivered}</td>
                    <td className={`px-4 py-2 text-right ${r.bounces > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                      {r.bounces || '—'}
                    </td>
                    <td className={`px-4 py-2 text-right ${r.unsubscribes > 0 ? 'text-amber-600' : 'text-gray-400'}`}>
                      {r.unsubscribes || '—'}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500">
                      {r.last_event_at
                        ? new Date(r.last_event_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' })
                        : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-gray-400 mt-4">
          Data refreshes every 5 min via the <code>email-engagement-refresh</code> cron.
          Raw events live in <code>sendgrid_events</code>; this view aggregates them.
        </p>
      </div>
    </div>
  );
}
