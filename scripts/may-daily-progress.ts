/**
 * May 2026 Daily Progress Update — Slack-or-email
 *
 * Posts a daily snapshot of progress against the May 2026 revenue plan:
 *   - Verifications today + MTD  (target: 264, ~12/business-day across 22 days)
 *   - Service deals MTD          (target: 8 @ $300 avg = $2,400)
 *   - Verification revenue       (target: $21,120 @ $80 avg)
 *   - Total revenue              (target: $23,520 driver / $25,000 income plan)
 *   - Pace flag (on track / behind / ahead)
 *
 * Delivery:
 *   - SLACK_WEBHOOK_URL set       → post to Slack (Block Kit format)
 *   - else                        → email matt@moderntax.io via SendGrid
 *
 * Run:
 *   npx tsx scripts/may-daily-progress.ts          # send for real
 *   npx tsx scripts/may-daily-progress.ts --dry    # render to /tmp without sending
 *
 * Service deals are sourced from `service_deals` table if present; otherwise
 * shows "—" and Matt can update manually. The table-or-skip pattern keeps the
 * script unblocked even before that schema exists.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';
import sgMail from '@sendgrid/mail';

if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const dryRun = process.argv.includes('--dry');
const slackWebhook = process.env.SLACK_WEBHOOK_URL;

// ---------------------------------------------------------------------------
// Plan constants — May 2026
// ---------------------------------------------------------------------------

const MAY_TARGETS = {
  verificationsTotal: 264,         // 12/day × 22 business days
  serviceDealsTotal: 8,
  verificationRevenue: 21120,      // 264 × $80 avg
  serviceRevenue: 2400,            // 8 × $300 avg
  driverTotalRevenue: 23520,
  incomeTargetRevenue: 25000,
  founderDistribution: 6250,       // 25% of plan
  businessDays: 22,
} as const;

// ---------------------------------------------------------------------------
// Business-day math
// ---------------------------------------------------------------------------

/** Count Mon-Fri days between (start, end] inclusive. */
function countBusinessDays(start: Date, endInclusive: Date): number {
  let count = 0;
  const d = new Date(start);
  while (d <= endInclusive) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

function formatMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function paceLabel(actual: number, expected: number): { label: string; emoji: string; color: string } {
  if (expected === 0) return { label: 'starting', emoji: '🟢', color: '#16a34a' };
  const ratio = actual / expected;
  if (ratio >= 1.10) return { label: 'AHEAD', emoji: '🚀', color: '#16a34a' };
  if (ratio >= 0.90) return { label: 'on pace', emoji: '🟢', color: '#16a34a' };
  if (ratio >= 0.70) return { label: 'slightly behind', emoji: '🟡', color: '#d97706' };
  return { label: 'BEHIND', emoji: '🔴', color: '#dc2626' };
}

// ---------------------------------------------------------------------------
// Stats query
// ---------------------------------------------------------------------------

interface DailyStats {
  todayDate: string;
  // Today (PT day window)
  ordersBookedToday: number;             // entities CREATED today
  verificationsCompletedToday: number;   // entities COMPLETED today
  // Month-to-date — bookings (created in May, regardless of status)
  bookingsMtd: number;
  bookingsRevenueMtd: number;            // committed revenue at order rate
  // Month-to-date — realized (completed in May, regardless of when created)
  realizedMtd: number;
  realizedRevenueMtd: number;
  // Month-to-date — outstanding (created in May but not yet completed/failed/cancelled)
  outstandingMtd: number;
  outstandingRevenueMtd: number;
  outstandingByStatus: { status: string; count: number }[];
  // Efficiency: of May-created entities (excl failed/cancelled), what % completed?
  // Captures throughput: are we converting orders to revenue fast enough?
  efficiencyPct: number;
  // Service deals (from service_deals table if exists)
  serviceDealsMtd: number | null;
  serviceRevenueMtd: number | null;
  // Pace
  businessDaysElapsed: number;
  businessDaysRemaining: number;
  // Per-client breakdown
  byClient: { name: string; bookings: number; realized: number; outstanding: number; revenue: number }[];
}

async function gatherStats(): Promise<DailyStats> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Period: May 2026 in UTC. Today is wherever the cron fires. Use PT
  // for "today" since the team and customers are all US-based; the simplest
  // approximation is UTC-7 (PDT in May).
  const now = new Date();
  const ptOffsetMs = -7 * 60 * 60 * 1000;
  const todayPt = new Date(now.getTime() + ptOffsetMs);
  const todayDate = todayPt.toISOString().split('T')[0]; // YYYY-MM-DD in PT
  const monthStartUtc = new Date('2026-05-01T07:00:00Z');   // 12am PT May 1
  const monthEndUtc = new Date('2026-06-01T07:00:00Z');     // 12am PT June 1
  const todayStartUtc = new Date(`${todayDate}T07:00:00Z`); // 12am PT today
  const todayEndUtc = new Date(todayStartUtc.getTime() + 24 * 60 * 60 * 1000);

  // Pull every May-relevant entity in one shot:
  //   - created in May (bookings) OR completed in May (realized — could be
  //     April-created but completed-in-May)
  // We then bucket each row in code by status + date.
  const [createdMay, completedMay] = await Promise.all([
    supabase.from('request_entities')
      .select('id, status, created_at, completed_at, requests!inner ( id, client_id, ' +
        'clients ( name, billing_rate_pdf, billing_model, subscription_monthly_amount ) )')
      .gte('created_at', monthStartUtc.toISOString())
      .lt('created_at', monthEndUtc.toISOString()) as Promise<{ data: any[] | null }>,
    supabase.from('request_entities')
      .select('id, status, created_at, completed_at, requests!inner ( id, client_id, ' +
        'clients ( name, billing_rate_pdf, billing_model, subscription_monthly_amount ) )')
      .eq('status', 'completed')
      .gte('completed_at', monthStartUtc.toISOString())
      .lt('completed_at', monthEndUtc.toISOString()) as Promise<{ data: any[] | null }>,
  ]);

  // Statuses that count as "in flight" — order received, work not yet done
  const INFLIGHT_STATUSES = new Set([
    'pending', '8821_sent', '8821_signed', 'irs_queue', 'processing',
    'assigned', 'in_progress', 'manual_review',
  ]);
  const TERMINAL_FAIL = new Set(['failed', 'cancelled', 'rejected']);

  let bookingsMtd = 0;
  let bookingsRevenueMtd = 0;
  let outstandingMtd = 0;
  let outstandingRevenueMtd = 0;
  let realizedMtd = 0;
  let realizedRevenueMtd = 0;
  let ordersBookedToday = 0;
  let verificationsCompletedToday = 0;
  const outstandingByStatus = new Map<string, number>();

  // Per-client aggregation
  const byClient = new Map<string, { name: string; bookings: number; realized: number; outstanding: number; revenue: number }>();
  const subscriptionClientsCountedRealized = new Set<string>();
  const subscriptionClientsCountedBookings = new Set<string>();

  // Helper to upsert a client bucket
  const ensureClient = (cid: string, name: string) => {
    let g = byClient.get(cid);
    if (!g) { g = { name, bookings: 0, realized: 0, outstanding: 0, revenue: 0 }; byClient.set(cid, g); }
    return g;
  };
  const rateFor = (c: any): { rate: number; subAmount: number; isSub: boolean } => {
    const isSub = c?.billing_model === 'subscription';
    return {
      rate: isSub ? 0 : (c?.billing_rate_pdf || 59.98),
      subAmount: c?.subscription_monthly_amount || 0,
      isSub,
    };
  };

  // Process May-created entities — everything bookings + outstanding
  for (const e of createdMay.data || []) {
    if (TERMINAL_FAIL.has(e.status)) continue;
    bookingsMtd++;
    if (e.created_at >= todayStartUtc.toISOString() && e.created_at < todayEndUtc.toISOString()) {
      ordersBookedToday++;
    }
    const c = e.requests?.clients;
    if (!c) continue;
    const cid = e.requests.client_id;
    const g = ensureClient(cid, c.name || '(unknown)');
    g.bookings++;
    const { rate, subAmount, isSub } = rateFor(c);
    if (isSub) {
      // Subscription: count once per month at the booking pass (flat fee captures all).
      if (!subscriptionClientsCountedBookings.has(cid)) {
        bookingsRevenueMtd += subAmount;
        subscriptionClientsCountedBookings.add(cid);
        // Sub revenue is fully outstanding until end of period; for visibility,
        // bucket all of it as "booked but not yet realized" until completed work
        // makes up the value. Simpler: mirror behavior of completedMay loop
        // (credit revenue once total, attribute as realized once any work done).
      }
    } else {
      bookingsRevenueMtd += rate;
    }
    if (INFLIGHT_STATUSES.has(e.status)) {
      outstandingMtd++;
      g.outstanding++;
      outstandingByStatus.set(e.status, (outstandingByStatus.get(e.status) || 0) + 1);
      if (!isSub) outstandingRevenueMtd += rate;
    }
  }

  // Process May-completed entities — realized revenue
  for (const e of completedMay.data || []) {
    realizedMtd++;
    if (e.completed_at >= todayStartUtc.toISOString() && e.completed_at < todayEndUtc.toISOString()) {
      verificationsCompletedToday++;
    }
    const c = e.requests?.clients;
    if (!c) continue;
    const cid = e.requests.client_id;
    const g = ensureClient(cid, c.name || '(unknown)');
    g.realized++;
    const { rate, subAmount, isSub } = rateFor(c);
    if (isSub) {
      if (!subscriptionClientsCountedRealized.has(cid)) {
        realizedRevenueMtd += subAmount;
        g.revenue += subAmount;
        subscriptionClientsCountedRealized.add(cid);
      }
    } else {
      realizedRevenueMtd += rate;
      g.revenue += rate;
    }
  }

  // Efficiency = realized / (created-in-May not-failed). Since realizedMtd may
  // include April-created completions, we compute against bookingsMtd for a
  // pure "May-created throughput" view. If you want a cash-vs-pipeline view,
  // use bookings vs realized at the revenue level.
  const efficiencyDenom = bookingsMtd;
  const efficiencyNum = bookingsMtd - outstandingMtd;
  const efficiencyPct = efficiencyDenom > 0 ? Math.round((efficiencyNum / efficiencyDenom) * 1000) / 10 : 0;

  // Service deals — try to query a `service_deals` table; if it doesn't
  // exist or has no May rows, return null so the report shows "—".
  let serviceDealsMtd: number | null = null;
  let serviceRevenueMtd: number | null = null;
  try {
    const { data: deals, error } = await supabase
      .from('service_deals' as any)
      .select('id, deal_value, closed_at')
      .gte('closed_at', monthStartUtc.toISOString())
      .lt('closed_at', monthEndUtc.toISOString()) as { data: any[] | null; error: any };
    if (!error) {
      serviceDealsMtd = (deals || []).length;
      serviceRevenueMtd = (deals || []).reduce((s, d) => s + Number(d.deal_value || 0), 0);
    }
  } catch {
    // Table doesn't exist yet — leave nulls
  }

  // Business-day math
  const businessDaysElapsed = countBusinessDays(monthStartUtc, todayPt);
  const totalBusinessDays = MAY_TARGETS.businessDays;
  const businessDaysRemaining = Math.max(0, totalBusinessDays - businessDaysElapsed);

  return {
    todayDate,
    ordersBookedToday,
    verificationsCompletedToday,
    bookingsMtd,
    bookingsRevenueMtd,
    realizedMtd,
    realizedRevenueMtd,
    outstandingMtd,
    outstandingRevenueMtd,
    outstandingByStatus: Array.from(outstandingByStatus.entries())
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count),
    efficiencyPct,
    serviceDealsMtd,
    serviceRevenueMtd,
    businessDaysElapsed,
    businessDaysRemaining,
    byClient: Array.from(byClient.values()).sort((a, b) => b.bookings - a.bookings),
  };
}

// ---------------------------------------------------------------------------
// Slack Block Kit message
// ---------------------------------------------------------------------------

function buildSlackBlocks(s: DailyStats) {
  const expectedBookingsToDate = Math.round((MAY_TARGETS.verificationsTotal / MAY_TARGETS.businessDays) * s.businessDaysElapsed);
  const bookingsPace = paceLabel(s.bookingsMtd, expectedBookingsToDate);
  const expectedRevenueToDate = Math.round((MAY_TARGETS.verificationRevenue / MAY_TARGETS.businessDays) * s.businessDaysElapsed);
  const realizedPace = paceLabel(s.realizedRevenueMtd, expectedRevenueToDate);
  const totalRealized = s.realizedRevenueMtd + (s.serviceRevenueMtd || 0);
  const totalBooked = s.bookingsRevenueMtd + (s.serviceRevenueMtd || 0);
  const expectedTotalRevenueToDate = Math.round((MAY_TARGETS.driverTotalRevenue / MAY_TARGETS.businessDays) * s.businessDaysElapsed);
  const totalPace = paceLabel(totalRealized, expectedTotalRevenueToDate);

  const dateLabel = new Date(s.todayDate + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  const todayLines = [
    `*New orders booked today:* ${s.ordersBookedToday}`,
    `*Verifications completed today:* ${s.verificationsCompletedToday}`,
  ];

  const bookingsLines = [
    `*Total bookings MTD:* ${s.bookingsMtd} / ${MAY_TARGETS.verificationsTotal}  ${bookingsPace.emoji} _${bookingsPace.label}_  (expected by today: ${expectedBookingsToDate})`,
    `*Booked revenue MTD:* ${formatMoney(s.bookingsRevenueMtd)} _(committed at order rate)_`,
    `*Realized MTD (completed):* ${s.realizedMtd} entities · ${formatMoney(s.realizedRevenueMtd)}  ${realizedPace.emoji} _${realizedPace.label}_`,
    `*Outstanding MTD (in flight):* ${s.outstandingMtd} entities · ${formatMoney(s.outstandingRevenueMtd)} potential`,
    `*Throughput efficiency:* ${s.efficiencyPct}% _(${s.bookingsMtd - s.outstandingMtd}/${s.bookingsMtd} of May bookings completed/failed)_`,
  ];

  const revenueLines = [
    s.serviceDealsMtd != null
      ? `*Service deals:* ${s.serviceDealsMtd} / ${MAY_TARGETS.serviceDealsTotal}  ·  ${formatMoney(s.serviceRevenueMtd || 0)} / ${formatMoney(MAY_TARGETS.serviceRevenue)}`
      : `*Service deals:* — _(service_deals table not populated — track manually)_`,
    `*Total realized revenue:* ${formatMoney(totalRealized)} / ${formatMoney(MAY_TARGETS.driverTotalRevenue)} driver  ·  ${formatMoney(MAY_TARGETS.incomeTargetRevenue)} income plan  ${totalPace.emoji} _${totalPace.label}_`,
    `*Total booked revenue:* ${formatMoney(totalBooked)} _(realized + booked-but-not-yet-completed)_`,
    `*Founder distribution at pace:* ${formatMoney(Math.round(totalRealized * 0.25))} / ${formatMoney(MAY_TARGETS.founderDistribution)} target _(based on realized)_`,
  ];

  const outstandingByStatusLine = s.outstandingByStatus.length > 0
    ? `*Outstanding by stage:* ${s.outstandingByStatus.map(o => `${o.status}: ${o.count}`).join(' · ')}`
    : '';

  const clientLines = s.byClient.map(c =>
    `• ${c.name}: ${c.bookings} booked (${c.realized} realized, ${c.outstanding} outstanding)  ·  ${formatMoney(c.revenue)} realized`
  ).join('\n');

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `ModernTax — May 2026 Daily Progress` },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `${dateLabel}  ·  Business day ${s.businessDaysElapsed}/${MAY_TARGETS.businessDays}  ·  ${s.businessDaysRemaining} remaining` },
      ],
    },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: '*Today*\n' + todayLines.join('\n') } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: '*Bookings & Throughput (MTD)*\n' + bookingsLines.join('\n') } },
    ...(outstandingByStatusLine ? [{ type: 'context' as const, elements: [{ type: 'mrkdwn' as const, text: outstandingByStatusLine }] }] : []),
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: '*Revenue (MTD)*\n' + revenueLines.join('\n') } },
    ...(s.byClient.length > 0 ? [
      { type: 'divider' as const },
      { type: 'section' as const, text: { type: 'mrkdwn' as const, text: `*By client (MTD):*\n${clientLines}` } },
    ] : []),
  ];
}

// ---------------------------------------------------------------------------
// Email fallback
// ---------------------------------------------------------------------------

function buildEmailHtml(s: DailyStats): string {
  const expectedBookingsToDate = Math.round((MAY_TARGETS.verificationsTotal / MAY_TARGETS.businessDays) * s.businessDaysElapsed);
  const bookingsPace = paceLabel(s.bookingsMtd, expectedBookingsToDate);
  const expectedRevenueToDate = Math.round((MAY_TARGETS.verificationRevenue / MAY_TARGETS.businessDays) * s.businessDaysElapsed);
  const realizedPace = paceLabel(s.realizedRevenueMtd, expectedRevenueToDate);
  const totalRealized = s.realizedRevenueMtd + (s.serviceRevenueMtd || 0);
  const totalBooked = s.bookingsRevenueMtd + (s.serviceRevenueMtd || 0);
  const expectedTotalRevenueToDate = Math.round((MAY_TARGETS.driverTotalRevenue / MAY_TARGETS.businessDays) * s.businessDaysElapsed);
  const totalPace = paceLabel(totalRealized, expectedTotalRevenueToDate);
  const dateLabel = new Date(s.todayDate + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const row = (label: string, actual: string, target: string, pace: { label: string; color: string } | null) =>
    `<tr><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;"><strong>${label}</strong></td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;text-align:right;">${actual}${target ? ` / ${target}` : ''}</td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;text-align:right;${pace ? `color:${pace.color};font-weight:600;` : 'color:#999;'}">${pace ? pace.label : '—'}</td></tr>`;

  const clientRows = s.byClient.map(c =>
    `<tr><td style="padding:8px 14px;border-bottom:1px solid #f1f5f9;">${c.name}</td><td style="padding:8px 14px;border-bottom:1px solid #f1f5f9;text-align:right;">${c.bookings}</td><td style="padding:8px 14px;border-bottom:1px solid #f1f5f9;text-align:right;color:#16a34a;">${c.realized}</td><td style="padding:8px 14px;border-bottom:1px solid #f1f5f9;text-align:right;color:#d97706;">${c.outstanding}</td><td style="padding:8px 14px;border-bottom:1px solid #f1f5f9;text-align:right;">${formatMoney(c.revenue)}</td></tr>`
  ).join('');

  const outstandingStatusRows = s.outstandingByStatus.length > 0
    ? `<p style="font-size:13px;color:#666;margin:8px 0 16px 0;"><strong>Outstanding by stage:</strong> ${s.outstandingByStatus.map(o => `${o.status} (${o.count})`).join(' · ')}</p>`
    : '';

  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;max-width:720px;margin:0 auto;padding:24px;">
<h2 style="margin:0 0 4px 0;">ModernTax — May 2026 Daily Progress</h2>
<p style="color:#666;margin:0 0 20px 0;">${dateLabel} · Business day ${s.businessDaysElapsed} of ${MAY_TARGETS.businessDays} · ${s.businessDaysRemaining} remaining</p>

<h3 style="font-size:15px;margin:24px 0 8px 0;">Today</h3>
<p style="margin:0 0 16px 0;font-size:14px;">
<strong>${s.ordersBookedToday}</strong> new order${s.ordersBookedToday === 1 ? '' : 's'} booked &nbsp;·&nbsp;
<strong>${s.verificationsCompletedToday}</strong> verification${s.verificationsCompletedToday === 1 ? '' : 's'} completed
</p>

<h3 style="font-size:15px;margin:24px 0 8px 0;">Bookings &amp; Throughput (MTD)</h3>
<table style="width:100%;border-collapse:collapse;font-size:14px;">
<thead><tr style="background:#f5f5f5;">
<th style="padding:10px 14px;text-align:left;">Metric</th>
<th style="padding:10px 14px;text-align:right;">Actual / Target</th>
<th style="padding:10px 14px;text-align:right;">Pace</th>
</tr></thead>
<tbody>
${row('Total bookings (orders received)', String(s.bookingsMtd), String(MAY_TARGETS.verificationsTotal), bookingsPace)}
${row('Realized (completed)', `${s.realizedMtd} entities`, '', null)}
${row('Outstanding (in flight)', `${s.outstandingMtd} entities`, '', null)}
${row('Throughput efficiency', `${s.efficiencyPct}%`, '', null)}
</tbody>
</table>
${outstandingStatusRows}

<h3 style="font-size:15px;margin:24px 0 8px 0;">Revenue (MTD)</h3>
<table style="width:100%;border-collapse:collapse;font-size:14px;">
<thead><tr style="background:#f5f5f5;">
<th style="padding:10px 14px;text-align:left;">Metric</th>
<th style="padding:10px 14px;text-align:right;">Actual / Target</th>
<th style="padding:10px 14px;text-align:right;">Pace</th>
</tr></thead>
<tbody>
${row('Realized verification revenue', formatMoney(s.realizedRevenueMtd), formatMoney(MAY_TARGETS.verificationRevenue), realizedPace)}
${row('Booked verification revenue', formatMoney(s.bookingsRevenueMtd), formatMoney(MAY_TARGETS.verificationRevenue), null)}
${row('Outstanding (potential) revenue', formatMoney(s.outstandingRevenueMtd), '', null)}
${s.serviceDealsMtd != null
  ? row('Service deals', `${s.serviceDealsMtd} · ${formatMoney(s.serviceRevenueMtd || 0)}`, `${MAY_TARGETS.serviceDealsTotal} · ${formatMoney(MAY_TARGETS.serviceRevenue)}`, paceLabel(s.serviceDealsMtd, Math.round((MAY_TARGETS.serviceDealsTotal / MAY_TARGETS.businessDays) * s.businessDaysElapsed)))
  : `<tr><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;"><strong>Service deals</strong></td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;text-align:right;color:#999;">— (manual track)</td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;"></td></tr>`}
${row('Total realized revenue', formatMoney(totalRealized), `${formatMoney(MAY_TARGETS.driverTotalRevenue)} driver / ${formatMoney(MAY_TARGETS.incomeTargetRevenue)} income plan`, totalPace)}
${row('Total booked revenue', formatMoney(totalBooked), '', null)}
${row('Founder distribution at pace (25% of realized)', formatMoney(Math.round(totalRealized * 0.25)), formatMoney(MAY_TARGETS.founderDistribution), paceLabel(totalRealized, expectedTotalRevenueToDate))}
</tbody>
</table>

${s.byClient.length > 0 ? `
<h3 style="font-size:15px;margin:24px 0 8px 0;">By client (MTD)</h3>
<table style="width:100%;border-collapse:collapse;font-size:13px;">
<thead><tr style="background:#f5f5f5;">
<th style="padding:8px 14px;text-align:left;">Client</th>
<th style="padding:8px 14px;text-align:right;">Booked</th>
<th style="padding:8px 14px;text-align:right;color:#16a34a;">Realized</th>
<th style="padding:8px 14px;text-align:right;color:#d97706;">Outstanding</th>
<th style="padding:8px 14px;text-align:right;">Realized $</th>
</tr></thead>
<tbody>${clientRows}</tbody>
</table>` : ''}

<p style="font-size:12px;color:#888;margin-top:24px;border-top:1px solid #eee;padding-top:16px;">Auto-generated. Add SLACK_WEBHOOK_URL to env to switch from email to Slack delivery.</p>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Send dispatch
// ---------------------------------------------------------------------------

async function postSlack(s: DailyStats) {
  const blocks = buildSlackBlocks(s);
  const totalRealized = s.realizedRevenueMtd + (s.serviceRevenueMtd || 0);
  const expectedTotalRevenueToDate = Math.round((MAY_TARGETS.driverTotalRevenue / MAY_TARGETS.businessDays) * s.businessDaysElapsed);
  const totalPace = paceLabel(totalRealized, expectedTotalRevenueToDate);
  const fallbackText = `May progress: ${s.bookingsMtd} booked / ${s.realizedMtd} realized of ${MAY_TARGETS.verificationsTotal} · ${formatMoney(totalRealized)} realized · ${totalPace.label}`;
  const res = await fetch(slackWebhook!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: fallbackText, blocks }),
  });
  if (!res.ok) {
    throw new Error(`Slack webhook ${res.status}: ${await res.text()}`);
  }
  console.log(`Posted to Slack (${fallbackText})`);
}

async function emailFallback(s: DailyStats) {
  const html = buildEmailHtml(s);
  const totalRealized = s.realizedRevenueMtd + (s.serviceRevenueMtd || 0);
  const expectedTotalRevenueToDate = Math.round((MAY_TARGETS.driverTotalRevenue / MAY_TARGETS.businessDays) * s.businessDaysElapsed);
  const pace = paceLabel(totalRealized, expectedTotalRevenueToDate);
  await sgMail.send({
    to: 'matt@moderntax.io',
    from: { email: 'hello@moderntax.io', name: 'ModernTax' },
    replyTo: 'hello@moderntax.io',
    subject: `[May Progress] ${s.bookingsMtd}/${MAY_TARGETS.verificationsTotal} bookings · ${formatMoney(totalRealized)} realized · ${pace.label}`,
    html,
  });
  console.log(`Sent email → matt@moderntax.io`);
}

async function main() {
  const stats = await gatherStats();
  console.log(`May progress: ${stats.bookingsMtd} booked / ${stats.realizedMtd} realized of ${MAY_TARGETS.verificationsTotal} target · ${formatMoney(stats.realizedRevenueMtd + (stats.serviceRevenueMtd || 0))} realized · ${stats.efficiencyPct}% throughput · business day ${stats.businessDaysElapsed}/${MAY_TARGETS.businessDays}`);

  if (dryRun) {
    const fs = await import('fs/promises');
    if (slackWebhook) {
      const blocks = buildSlackBlocks(stats);
      await fs.writeFile('/tmp/may-progress-slack.json', JSON.stringify({ blocks }, null, 2));
      console.log('Wrote /tmp/may-progress-slack.json');
    }
    await fs.writeFile('/tmp/may-progress-email.html', buildEmailHtml(stats));
    console.log('Wrote /tmp/may-progress-email.html');
    return;
  }

  if (slackWebhook) {
    await postSlack(stats);
  } else {
    console.log('SLACK_WEBHOOK_URL not set — falling back to email.');
    await emailFallback(stats);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
