/**
 * Email engagement + campaign performance + revenue attribution.
 *
 * URL: /admin/email-engagement?tab=campaigns
 *
 * Three tabs:
 *   1. Recipients (default) — per-recipient ranking (clicks×3 + opens)
 *      Source: email_engagement_summary materialized view
 *   2. Campaigns           — per-category funnel + computed rates
 *      Source: email_campaign_summary materialized view (new)
 *   3. Conversions         — conversion events attributed to email clicks
 *      Source: email_attributed_conversions live view (new, joins clicks
 *               to recent requests/8821s/paid invoices within 30-day window)
 *
 * Schemas:
 *   - supabase/migration-sendgrid-events.sql                 (base events + recipient view)
 *   - supabase/migration-email-campaigns-and-attribution.sql (campaign view + conversion view)
 */

import { redirect } from 'next/navigation';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';
import Link from 'next/link';

interface RecipientRow {
  email: string; opens: number; unique_opens: number; clicks: number; unique_clicks: number;
  delivered: number; bounces: number; spam_reports: number; unsubscribes: number;
  score: number; first_event_at: string | null; last_event_at: string | null; categories: string[] | null;
}

interface CampaignRow {
  category: string;
  sent: number; delivered: number;
  unique_opens: number; opens: number;
  unique_clicks: number; clicks: number;
  bounces: number; spam_reports: number; unsubscribes: number;
  delivery_rate: number | null; open_rate: number | null;
  click_through_rate: number | null; click_rate: number | null;
  first_event_at: string | null; last_event_at: string | null;
}

interface ConversionRow {
  email: string;
  converted_at: string;
  conversion_type: 'request_submitted' | '8821_signed' | 'invoice_paid';
  conversion_ref: string;
  conversion_label: string | null;
  conversion_value: number | null;
  attributed_category: string | null;
  attributed_subject: string | null;
  attributed_clicked_at: string | null;
  days_to_convert: string | null; // postgres interval as ISO 8601
}

interface SearchParams {
  tab?: 'recipients' | 'campaigns' | 'conversions';
  category?: string;
  min_clicks?: string;
  since?: string;
}

const TABS: { id: NonNullable<SearchParams['tab']>; label: string; desc: string }[] = [
  { id: 'recipients', label: 'Recipients', desc: 'Per-recipient ranking by engagement score' },
  { id: 'campaigns', label: 'Campaigns', desc: 'Per-category funnel + delivery / open / click rates' },
  { id: 'conversions', label: 'Conversions', desc: 'Orders, signatures, paid invoices attributed to email clicks' },
];

const CONVERSION_TYPE_LABEL: Record<ConversionRow['conversion_type'], string> = {
  request_submitted: 'New request',
  '8821_signed':     '8821 signed',
  invoice_paid:      'Invoice paid',
};

const CONVERSION_TYPE_COLOR: Record<ConversionRow['conversion_type'], string> = {
  request_submitted: 'bg-blue-100 text-blue-900 border-blue-300',
  '8821_signed':     'bg-emerald-100 text-emerald-900 border-emerald-300',
  invoice_paid:      'bg-amber-100 text-amber-900 border-amber-300',
};

const usd = (n: number | null) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const pct = (n: number | null) => (n == null ? '—' : `${n}%`);

export default async function EmailEngagementPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const tab: NonNullable<SearchParams['tab']> = sp.tab || 'recipients';

  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (!profile || profile.role !== 'admin') redirect('/');

  const admin = createAdminClient();

  // Refresh-on-view (cheap, CONCURRENTLY). Best-effort — failures don't block render.
  try {
    await (admin as any).rpc('refresh_email_engagement_summary');
  } catch (refreshErr) {
    console.warn('[email-engagement] refresh failed:', refreshErr);
  }

  // ─── Load data for the active tab ───────────────────────────────────────
  let recipients: RecipientRow[] = [];
  let campaigns: CampaignRow[] = [];
  let conversions: ConversionRow[] = [];
  let dataError: string | null = null;
  const categoryFilter = sp.category || null;

  try {
    if (tab === 'recipients') {
      let q = (admin.from('email_engagement_summary' as any) as any)
        .select('*').order('score', { ascending: false }).limit(200);
      if (categoryFilter) q = q.contains('categories', [categoryFilter]);
      if (sp.min_clicks) { const n = parseInt(sp.min_clicks, 10); if (Number.isFinite(n)) q = q.gte('clicks', n); }
      if (sp.since) q = q.gte('last_event_at', sp.since);
      const { data, error } = await q as { data: RecipientRow[] | null; error: any };
      if (error) throw error;
      recipients = data || [];
    } else if (tab === 'campaigns') {
      const { data, error } = await (admin.from('email_campaign_summary' as any) as any)
        .select('*').order('sent', { ascending: false }).limit(100) as { data: CampaignRow[] | null; error: any };
      if (error) throw error;
      campaigns = data || [];
    } else if (tab === 'conversions') {
      let q = (admin.from('email_attributed_conversions' as any) as any)
        .select('*').order('converted_at', { ascending: false }).limit(300);
      if (categoryFilter) q = q.eq('attributed_category', categoryFilter);
      const { data, error } = await q as { data: ConversionRow[] | null; error: any };
      if (error) throw error;
      conversions = data || [];
    }
  } catch (err: any) {
    dataError = err?.message || 'failed to load';
  }

  // Cross-tab: category list pulled from campaign view (cheapest source)
  let allCategories: string[] = [];
  try {
    const { data: catRows } = await (admin.from('email_campaign_summary' as any) as any)
      .select('category').limit(200) as { data: { category: string }[] | null };
    allCategories = (catRows || []).map(r => r.category).filter(Boolean).sort();
  } catch { /* table may not exist yet — fine */ }

  // Setup-needed callout if the views don't exist
  if (dataError && /does not exist|not found|schema cache/i.test(dataError)) {
    return (
      <div className="max-w-5xl mx-auto p-8">
        <Link href="/admin" className="text-xs text-gray-500 hover:text-gray-700">← Admin</Link>
        <h1 className="text-2xl font-bold text-mt-dark mt-1">Email engagement</h1>
        <div className="mt-6 bg-amber-50 border border-amber-200 rounded p-4">
          <p className="text-sm font-semibold text-amber-900">
            The engagement infrastructure isn&apos;t set up yet.
          </p>
          <ol className="list-decimal pl-6 mt-2 text-sm text-amber-800 space-y-1">
            <li>Run <code className="bg-amber-100 px-1 rounded">supabase/migration-sendgrid-events.sql</code> in Supabase SQL Editor.</li>
            <li>Then run <code className="bg-amber-100 px-1 rounded">supabase/migration-email-campaigns-and-attribution.sql</code> for the Campaigns + Conversions tabs.</li>
            <li>In SendGrid → Settings → Mail Settings → Event Webhook: set URL to <code className="bg-amber-100 px-1 rounded">https://portal.moderntax.io/api/webhook/sendgrid-events</code>, enable signature verification, paste the public key into <code className="bg-amber-100 px-1 rounded">SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY</code> Vercel env var.</li>
          </ol>
          <p className="text-sm text-amber-800 mt-3">After all three, send one test email; events populate within seconds.</p>
        </div>
        <div className="mt-4 text-xs text-gray-500">Error: {dataError}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <Link href="/admin" className="text-xs text-gray-500 hover:text-gray-700">← Admin</Link>
          <h1 className="text-2xl sm:text-3xl font-bold text-mt-dark mt-1">Email Performance</h1>
          <p className="text-gray-600 text-sm mt-1">{TABS.find(t => t.id === tab)?.desc}</p>
        </div>

        {/* Tab nav */}
        <div className="border-b border-gray-200 mb-6">
          <nav className="flex gap-1 -mb-px" aria-label="Tabs">
            {TABS.map(t => {
              const active = t.id === tab;
              const url = `/admin/email-engagement?tab=${t.id}`;
              return (
                <Link
                  key={t.id}
                  href={url}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    active
                      ? 'border-mt-green text-mt-dark'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  {t.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Tab body */}
        {tab === 'recipients' && (
          <RecipientsTab recipients={recipients} categories={allCategories} category={categoryFilter} minClicks={sp.min_clicks} />
        )}
        {tab === 'campaigns' && (
          <CampaignsTab campaigns={campaigns} />
        )}
        {tab === 'conversions' && (
          <ConversionsTab conversions={conversions} categories={allCategories} category={categoryFilter} />
        )}

        <p className="text-xs text-gray-400 mt-6">
          Materialized views refresh every 5 min via cron + on each page view (cheap CONCURRENTLY refresh).
          Conversions are joined live (not materialized) so attribution is always current.
        </p>
      </div>
    </div>
  );
}

// =============================================================================
// Recipients tab
// =============================================================================

function RecipientsTab({
  recipients, categories, category, minClicks,
}: {
  recipients: RecipientRow[]; categories: string[]; category: string | null; minClicks?: string;
}) {
  const clickHeavy = recipients.filter(r => r.clicks >= 2 && r.unsubscribes === 0 && r.spam_reports === 0);
  return (
    <>
      <form className="flex items-center gap-2 text-sm mb-4">
        <input type="hidden" name="tab" value="recipients" />
        <select name="category" defaultValue={category || ''} className="border border-gray-300 rounded px-3 py-1.5 bg-white">
          <option value="">All campaigns</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input type="number" name="min_clicks" defaultValue={minClicks || ''} placeholder="Min clicks" className="border border-gray-300 rounded px-3 py-1.5 w-28" min={0} />
        <button type="submit" className="px-3 py-1.5 bg-mt-dark text-white rounded hover:bg-mt-navy">Filter</button>
      </form>

      {clickHeavy.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-5 mb-6">
          <h2 className="text-base font-bold text-red-800 flex items-center gap-2">
            <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></span>
            {clickHeavy.length} hot lead{clickHeavy.length === 1 ? '' : 's'} (≥2 clicks, no unsub/spam)
          </h2>
          <ul className="mt-3 space-y-1 text-sm">
            {clickHeavy.slice(0, 10).map(r => (
              <li key={r.email} className="flex items-baseline gap-3">
                <span className="font-mono text-xs text-red-700 w-12 text-right">{r.clicks}c</span>
                <span className="font-mono text-xs text-gray-500 w-12 text-right">{r.opens}o</span>
                <a href={`mailto:${r.email}`} className="text-mt-dark hover:text-mt-green font-medium">{r.email}</a>
              </li>
            ))}
          </ul>
        </div>
      )}

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
              <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-500">No engagement events yet.</td></tr>
            ) : recipients.map((r, i) => (
              <tr key={r.email} className={`hover:bg-gray-50 ${r.unsubscribes > 0 || r.spam_reports > 0 ? 'opacity-50' : ''}`}>
                <td className="px-4 py-2 text-gray-500 font-mono text-xs">{i + 1}</td>
                <td className="px-4 py-2">
                  <a href={`mailto:${r.email}`} className="font-medium text-mt-dark hover:text-mt-green">{r.email}</a>
                  {r.unsubscribes > 0 && <span className="ml-2 text-xs text-gray-400">unsubscribed</span>}
                  {r.spam_reports > 0 && <span className="ml-2 text-xs text-red-600 font-semibold">SPAM</span>}
                </td>
                <td className="px-4 py-2 text-right font-mono font-bold">{r.score}</td>
                <td className={`px-4 py-2 text-right font-mono ${r.clicks > 0 ? 'text-mt-green font-semibold' : 'text-gray-400'}`}>{r.clicks}</td>
                <td className="px-4 py-2 text-right font-mono text-gray-700">{r.opens}</td>
                <td className="px-4 py-2 text-right text-gray-600">{r.delivered}</td>
                <td className={`px-4 py-2 text-right ${r.bounces > 0 ? 'text-red-600' : 'text-gray-400'}`}>{r.bounces || '—'}</td>
                <td className={`px-4 py-2 text-right ${r.unsubscribes > 0 ? 'text-amber-600' : 'text-gray-400'}`}>{r.unsubscribes || '—'}</td>
                <td className="px-4 py-2 text-xs text-gray-500">
                  {r.last_event_at ? new Date(r.last_event_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// =============================================================================
// Campaigns tab
// =============================================================================

function CampaignsTab({ campaigns }: { campaigns: CampaignRow[] }) {
  const totals = campaigns.reduce((acc, c) => ({
    sent: acc.sent + c.sent, delivered: acc.delivered + c.delivered,
    unique_opens: acc.unique_opens + c.unique_opens, unique_clicks: acc.unique_clicks + c.unique_clicks,
    unsubs: acc.unsubs + c.unsubscribes, spam: acc.spam + c.spam_reports,
  }), { sent: 0, delivered: 0, unique_opens: 0, unique_clicks: 0, unsubs: 0, spam: 0 });

  return (
    <>
      {/* Totals strip */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-6">
        <Kpi label="Sent" value={totals.sent.toLocaleString()} />
        <Kpi label="Delivered" value={totals.delivered.toLocaleString()} />
        <Kpi label="Unique opens" value={totals.unique_opens.toLocaleString()} />
        <Kpi label="Unique clicks" value={totals.unique_clicks.toLocaleString()} highlight />
        <Kpi label="Unsubs" value={totals.unsubs.toLocaleString()} bad={totals.unsubs > 0} />
        <Kpi label="Spam reports" value={totals.spam.toLocaleString()} bad={totals.spam > 0} />
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-600">
            <tr>
              <th className="px-4 py-2 text-left">Campaign / Category</th>
              <th className="px-4 py-2 text-right">Sent</th>
              <th className="px-4 py-2 text-right">Delivered</th>
              <th className="px-4 py-2 text-right">Delivery rate</th>
              <th className="px-4 py-2 text-right">Open rate</th>
              <th className="px-4 py-2 text-right">CTR (of opens)</th>
              <th className="px-4 py-2 text-right">Click rate</th>
              <th className="px-4 py-2 text-right">Bounces</th>
              <th className="px-4 py-2 text-right">Unsubs</th>
              <th className="px-4 py-2 text-left">Last event</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {campaigns.length === 0 ? (
              <tr><td colSpan={10} className="px-4 py-8 text-center text-gray-500 italic">No campaign data yet — tag your sends with categories and let events flow in.</td></tr>
            ) : campaigns.map(c => (
              <tr key={c.category} className="hover:bg-gray-50">
                <td className="px-4 py-2">
                  <Link href={`/admin/email-engagement?tab=conversions&category=${encodeURIComponent(c.category)}`} className="font-mono text-xs text-mt-dark hover:text-mt-green">
                    {c.category}
                  </Link>
                </td>
                <td className="px-4 py-2 text-right font-mono">{c.sent.toLocaleString()}</td>
                <td className="px-4 py-2 text-right font-mono">{c.delivered.toLocaleString()}</td>
                <td className="px-4 py-2 text-right font-mono">{pct(c.delivery_rate)}</td>
                <td className={`px-4 py-2 text-right font-mono ${c.open_rate && c.open_rate > 25 ? 'text-emerald-700 font-semibold' : ''}`}>{pct(c.open_rate)}</td>
                <td className={`px-4 py-2 text-right font-mono ${c.click_through_rate && c.click_through_rate > 10 ? 'text-emerald-700 font-semibold' : ''}`}>{pct(c.click_through_rate)}</td>
                <td className="px-4 py-2 text-right font-mono">{pct(c.click_rate)}</td>
                <td className={`px-4 py-2 text-right ${c.bounces > 0 ? 'text-red-600' : 'text-gray-400'}`}>{c.bounces || '—'}</td>
                <td className={`px-4 py-2 text-right ${c.unsubscribes > 0 ? 'text-amber-600' : 'text-gray-400'}`}>{c.unsubscribes || '—'}</td>
                <td className="px-4 py-2 text-xs text-gray-500">
                  {c.last_event_at ? new Date(c.last_event_at).toLocaleString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// =============================================================================
// Conversions tab
// =============================================================================

function ConversionsTab({
  conversions, categories, category,
}: {
  conversions: ConversionRow[]; categories: string[]; category: string | null;
}) {
  // Totals by type + attributed-revenue
  const totals = conversions.reduce((acc, c) => {
    acc.byType[c.conversion_type] = (acc.byType[c.conversion_type] || 0) + 1;
    if (c.conversion_value) acc.attributedValue += Number(c.conversion_value);
    if (c.attributed_category) acc.attributed += 1;
    return acc;
  }, { byType: {} as Record<string, number>, attributedValue: 0, attributed: 0 });

  const attributionRate = conversions.length > 0
    ? Math.round(100 * totals.attributed / conversions.length)
    : 0;

  return (
    <>
      <form className="flex items-center gap-2 text-sm mb-4">
        <input type="hidden" name="tab" value="conversions" />
        <select name="category" defaultValue={category || ''} className="border border-gray-300 rounded px-3 py-1.5 bg-white">
          <option value="">All campaigns</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button type="submit" className="px-3 py-1.5 bg-mt-dark text-white rounded hover:bg-mt-navy">Filter</button>
      </form>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <Kpi label="Total conversions" value={conversions.length.toLocaleString()} />
        <Kpi label="New requests" value={(totals.byType['request_submitted'] || 0).toLocaleString()} />
        <Kpi label="8821s signed" value={(totals.byType['8821_signed'] || 0).toLocaleString()} />
        <Kpi label="Invoices paid" value={(totals.byType['invoice_paid'] || 0).toLocaleString()} highlight />
        <Kpi label="Attributed revenue" value={usd(totals.attributedValue)} highlight />
      </div>

      <p className="text-xs text-gray-500 mb-3 italic">
        {totals.attributed} of {conversions.length} conversions ({attributionRate}%) attributed to an email click within 30 days. Unattributed conversions are direct/organic.
      </p>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-600">
            <tr>
              <th className="px-4 py-2 text-left">When</th>
              <th className="px-4 py-2 text-left">Type</th>
              <th className="px-4 py-2 text-left">Recipient</th>
              <th className="px-4 py-2 text-left">Reference</th>
              <th className="px-4 py-2 text-right">Value</th>
              <th className="px-4 py-2 text-left">Attributed to</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {conversions.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500 italic">No conversions in the last 90 days.</td></tr>
            ) : conversions.map(c => (
              <tr key={`${c.conversion_type}-${c.conversion_ref}`} className="hover:bg-gray-50">
                <td className="px-4 py-2 text-xs text-gray-500">
                  {new Date(c.converted_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </td>
                <td className="px-4 py-2">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded border ${CONVERSION_TYPE_COLOR[c.conversion_type]}`}>
                    {CONVERSION_TYPE_LABEL[c.conversion_type]}
                  </span>
                </td>
                <td className="px-4 py-2"><a href={`mailto:${c.email}`} className="text-mt-dark hover:text-mt-green">{c.email}</a></td>
                <td className="px-4 py-2 font-mono text-xs">{c.conversion_label || c.conversion_ref.slice(0, 8)}</td>
                <td className="px-4 py-2 text-right font-mono">{usd(c.conversion_value)}</td>
                <td className="px-4 py-2 text-xs">
                  {c.attributed_category ? (
                    <Link href={`/admin/email-engagement?tab=campaigns`} className="text-mt-green hover:text-mt-dark font-medium">
                      {c.attributed_category}
                    </Link>
                  ) : (
                    <span className="text-gray-400 italic">direct</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// =============================================================================
// Shared KPI tile
// =============================================================================

function Kpi({ label, value, highlight = false, bad = false }: { label: string; value: string; highlight?: boolean; bad?: boolean }) {
  const cls = bad
    ? 'bg-red-50 border-red-200 text-red-900'
    : highlight
    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
    : 'bg-white border-gray-200 text-gray-900';
  return (
    <div className={`rounded-lg border p-3 ${cls}`}>
      <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">{label}</div>
      <div className="text-lg font-bold mt-0.5">{value}</div>
    </div>
  );
}
