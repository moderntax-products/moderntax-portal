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
  // Verifications
  verificationsToday: number;
  verificationsMtd: number;
  verificationRevenueMtd: number;
  // Service deals
  serviceDealsMtd: number | null;        // null if table doesn't exist
  serviceRevenueMtd: number | null;
  // Pace
  businessDaysElapsed: number;
  businessDaysRemaining: number;
  // Per-client breakdown (for color)
  byClient: { name: string; count: number; revenue: number }[];
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

  // Pull all completed entities for May 2026, with client billing config
  const { data: entities } = await supabase
    .from('request_entities')
    .select('id, completed_at, requests!inner ( id, client_id, ' +
      'clients ( name, billing_rate_pdf, billing_model, subscription_monthly_amount ) )')
    .eq('status', 'completed')
    .gte('completed_at', monthStartUtc.toISOString())
    .lt('completed_at', monthEndUtc.toISOString()) as { data: any[] | null };

  let verificationsMtd = 0;
  let verificationsToday = 0;
  let revenueMtd = 0;
  const byClient = new Map<string, { name: string; count: number; revenue: number }>();
  // Track which subscription clients we've already credited (count once per month)
  const subscriptionClientsCounted = new Set<string>();

  for (const e of entities || []) {
    verificationsMtd++;
    if (e.completed_at >= todayStartUtc.toISOString() && e.completed_at < todayEndUtc.toISOString()) {
      verificationsToday++;
    }
    const c = e.requests?.clients;
    if (!c) continue;
    const isSubscription = c.billing_model === 'subscription';
    const rate = isSubscription ? 0 : (c.billing_rate_pdf || 59.98);
    const cid = e.requests.client_id;
    let g = byClient.get(cid);
    if (!g) {
      g = { name: c.name || '(unknown)', count: 0, revenue: 0 };
      byClient.set(cid, g);
    }
    g.count++;
    if (!isSubscription) {
      g.revenue += rate;
      revenueMtd += rate;
    } else if (!subscriptionClientsCounted.has(cid)) {
      // Credit subscription monthly amount once per month for this client
      const sub = c.subscription_monthly_amount || 0;
      g.revenue += sub;
      revenueMtd += sub;
      subscriptionClientsCounted.add(cid);
    }
  }

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
    verificationsToday,
    verificationsMtd,
    verificationRevenueMtd: revenueMtd,
    serviceDealsMtd,
    serviceRevenueMtd,
    businessDaysElapsed,
    businessDaysRemaining,
    byClient: Array.from(byClient.values()).sort((a, b) => b.count - a.count),
  };
}

// ---------------------------------------------------------------------------
// Slack Block Kit message
// ---------------------------------------------------------------------------

function buildSlackBlocks(s: DailyStats) {
  const expectedToDate = Math.round((MAY_TARGETS.verificationsTotal / MAY_TARGETS.businessDays) * s.businessDaysElapsed);
  const verificationPace = paceLabel(s.verificationsMtd, expectedToDate);
  const expectedRevenueToDate = Math.round((MAY_TARGETS.verificationRevenue / MAY_TARGETS.businessDays) * s.businessDaysElapsed);
  const totalRevenue = s.verificationRevenueMtd + (s.serviceRevenueMtd || 0);
  const expectedTotalRevenueToDate = Math.round((MAY_TARGETS.driverTotalRevenue / MAY_TARGETS.businessDays) * s.businessDaysElapsed);
  const totalPace = paceLabel(totalRevenue, expectedTotalRevenueToDate);

  const dateLabel = new Date(s.todayDate + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  const lines: string[] = [];
  lines.push(`*Verifications today:* ${s.verificationsToday}`);
  lines.push(`*Verifications MTD:* ${s.verificationsMtd} / ${MAY_TARGETS.verificationsTotal}  ${verificationPace.emoji} _${verificationPace.label}_  (expected by today: ${expectedToDate})`);
  lines.push(`*Verification revenue MTD:* ${formatMoney(s.verificationRevenueMtd)} / ${formatMoney(MAY_TARGETS.verificationRevenue)}  (expected: ${formatMoney(expectedRevenueToDate)})`);
  if (s.serviceDealsMtd != null) {
    lines.push(`*Service deals MTD:* ${s.serviceDealsMtd} / ${MAY_TARGETS.serviceDealsTotal}  |  ${formatMoney(s.serviceRevenueMtd || 0)} / ${formatMoney(MAY_TARGETS.serviceRevenue)}`);
  } else {
    lines.push(`*Service deals MTD:* — _(service_deals table not yet populated — track manually)_`);
  }
  lines.push(`*Total revenue MTD:* ${formatMoney(totalRevenue)} / ${formatMoney(MAY_TARGETS.driverTotalRevenue)} driver  ·  ${formatMoney(MAY_TARGETS.incomeTargetRevenue)} income plan  ${totalPace.emoji} _${totalPace.label}_`);
  lines.push(`*Founder distribution at pace:* ${formatMoney(Math.round(totalRevenue * 0.25))} / ${formatMoney(MAY_TARGETS.founderDistribution)} target`);

  const clientLines = s.byClient.map(c =>
    `• ${c.name}: ${c.count} verification${c.count === 1 ? '' : 's'} (${formatMoney(c.revenue)})`
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
    {
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') },
    },
    ...(s.byClient.length > 0 ? [
      { type: 'divider' as const },
      {
        type: 'section' as const,
        text: { type: 'mrkdwn' as const, text: `*Verifications by client (MTD):*\n${clientLines}` },
      },
    ] : []),
  ];
}

// ---------------------------------------------------------------------------
// Email fallback
// ---------------------------------------------------------------------------

function buildEmailHtml(s: DailyStats): string {
  const expectedToDate = Math.round((MAY_TARGETS.verificationsTotal / MAY_TARGETS.businessDays) * s.businessDaysElapsed);
  const verificationPace = paceLabel(s.verificationsMtd, expectedToDate);
  const expectedRevenueToDate = Math.round((MAY_TARGETS.verificationRevenue / MAY_TARGETS.businessDays) * s.businessDaysElapsed);
  const totalRevenue = s.verificationRevenueMtd + (s.serviceRevenueMtd || 0);
  const expectedTotalRevenueToDate = Math.round((MAY_TARGETS.driverTotalRevenue / MAY_TARGETS.businessDays) * s.businessDaysElapsed);
  const totalPace = paceLabel(totalRevenue, expectedTotalRevenueToDate);
  const dateLabel = new Date(s.todayDate + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const row = (label: string, actual: string, target: string, pace: { label: string; color: string }) =>
    `<tr><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;"><strong>${label}</strong></td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;text-align:right;">${actual} / ${target}</td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;text-align:right;color:${pace.color};font-weight:600;">${pace.label}</td></tr>`;

  const clientRows = s.byClient.map(c =>
    `<tr><td style="padding:8px 14px;border-bottom:1px solid #f1f5f9;">${c.name}</td><td style="padding:8px 14px;border-bottom:1px solid #f1f5f9;text-align:right;">${c.count}</td><td style="padding:8px 14px;border-bottom:1px solid #f1f5f9;text-align:right;">${formatMoney(c.revenue)}</td></tr>`
  ).join('');

  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;max-width:680px;margin:0 auto;padding:24px;">
<h2 style="margin:0 0 4px 0;">ModernTax — May 2026 Daily Progress</h2>
<p style="color:#666;margin:0 0 20px 0;">${dateLabel} · Business day ${s.businessDaysElapsed} of ${MAY_TARGETS.businessDays} · ${s.businessDaysRemaining} remaining</p>

<h3 style="font-size:15px;margin:24px 0 8px 0;">Today</h3>
<p style="margin:0 0 16px 0;font-size:15px;">${s.verificationsToday} verification${s.verificationsToday === 1 ? '' : 's'} completed today.</p>

<h3 style="font-size:15px;margin:24px 0 8px 0;">Month-to-date</h3>
<table style="width:100%;border-collapse:collapse;font-size:14px;">
<thead><tr style="background:#f5f5f5;">
<th style="padding:10px 14px;text-align:left;">Metric</th>
<th style="padding:10px 14px;text-align:right;">Actual / Target</th>
<th style="padding:10px 14px;text-align:right;">Pace</th>
</tr></thead>
<tbody>
${row('Verifications', String(s.verificationsMtd), String(MAY_TARGETS.verificationsTotal), verificationPace)}
${row('Verification revenue', formatMoney(s.verificationRevenueMtd), formatMoney(MAY_TARGETS.verificationRevenue), paceLabel(s.verificationRevenueMtd, expectedRevenueToDate))}
${s.serviceDealsMtd != null
  ? row('Service deals', String(s.serviceDealsMtd), String(MAY_TARGETS.serviceDealsTotal), paceLabel(s.serviceDealsMtd, Math.round((MAY_TARGETS.serviceDealsTotal / MAY_TARGETS.businessDays) * s.businessDaysElapsed)))
  : `<tr><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;"><strong>Service deals</strong></td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;text-align:right;color:#999;">— (manual track)</td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;"></td></tr>`}
${row('Total revenue', formatMoney(totalRevenue), formatMoney(MAY_TARGETS.driverTotalRevenue), totalPace)}
${row('Founder distribution at pace (25%)', formatMoney(Math.round(totalRevenue * 0.25)), formatMoney(MAY_TARGETS.founderDistribution), paceLabel(totalRevenue, expectedTotalRevenueToDate))}
</tbody>
</table>

${s.byClient.length > 0 ? `
<h3 style="font-size:15px;margin:24px 0 8px 0;">Verifications by client</h3>
<table style="width:100%;border-collapse:collapse;font-size:13px;">
<thead><tr style="background:#f5f5f5;"><th style="padding:8px 14px;text-align:left;">Client</th><th style="padding:8px 14px;text-align:right;">Count</th><th style="padding:8px 14px;text-align:right;">Revenue</th></tr></thead>
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
  const totalRevenue = s.verificationRevenueMtd + (s.serviceRevenueMtd || 0);
  const expectedTotalRevenueToDate = Math.round((MAY_TARGETS.driverTotalRevenue / MAY_TARGETS.businessDays) * s.businessDaysElapsed);
  const totalPace = paceLabel(totalRevenue, expectedTotalRevenueToDate);
  const fallbackText = `May progress: ${s.verificationsMtd}/${MAY_TARGETS.verificationsTotal} verifications · ${formatMoney(totalRevenue)} revenue · ${totalPace.label}`;
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
  const totalRevenue = s.verificationRevenueMtd + (s.serviceRevenueMtd || 0);
  const expectedTotalRevenueToDate = Math.round((MAY_TARGETS.driverTotalRevenue / MAY_TARGETS.businessDays) * s.businessDaysElapsed);
  const pace = paceLabel(totalRevenue, expectedTotalRevenueToDate);
  await sgMail.send({
    to: 'matt@moderntax.io',
    from: { email: 'hello@moderntax.io', name: 'ModernTax' },
    replyTo: 'hello@moderntax.io',
    subject: `[May Progress] ${s.verificationsMtd}/${MAY_TARGETS.verificationsTotal} verifications · ${formatMoney(totalRevenue)} · ${pace.label}`,
    html,
  });
  console.log(`Sent email → matt@moderntax.io`);
}

async function main() {
  const stats = await gatherStats();
  console.log(`May progress: ${stats.verificationsMtd}/${MAY_TARGETS.verificationsTotal} verifications, ${formatMoney(stats.verificationRevenueMtd + (stats.serviceRevenueMtd || 0))} revenue, business day ${stats.businessDaysElapsed}/${MAY_TARGETS.businessDays}`);

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
