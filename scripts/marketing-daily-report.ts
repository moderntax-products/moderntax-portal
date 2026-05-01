/**
 * Daily marketing campaign stats report
 *
 * Pulls SendGrid category stats for the May 2026 campaign and emails Matt
 * a digest each morning so he can review performance and decide whether
 * to tweak subject lines, copy, or pause/accelerate the daily 25/day cadence.
 *
 * Stats pulled (per category, per day):
 *   - delivered, opened, clicked, bounced, spam_reports, unsubscribes
 *
 * Categories tracked:
 *   - may2026 (umbrella)
 *   - lender_reactivation
 *   - compliance_outreach
 *
 * Run:
 *   npx tsx scripts/marketing-daily-report.ts        # send to matt@moderntax.io
 *   npx tsx scripts/marketing-daily-report.ts --dry-run
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import sgMail from '@sendgrid/mail';

const dryRun = process.argv.includes('--dry-run');
const SG_KEY = process.env.SENDGRID_API_KEY!;
sgMail.setApiKey(SG_KEY);

interface StatBucket {
  delivered: number; opens: number; uniqueOpens: number;
  clicks: number; uniqueClicks: number; bounces: number;
  spamReports: number; unsubscribes: number;
  requests: number;
}

const empty = (): StatBucket => ({
  delivered: 0, opens: 0, uniqueOpens: 0, clicks: 0, uniqueClicks: 0,
  bounces: 0, spamReports: 0, unsubscribes: 0, requests: 0,
});

async function fetchCategoryStats(category: string, startDate: string, endDate: string): Promise<StatBucket> {
  const url = `https://api.sendgrid.com/v3/categories/stats?categories=${encodeURIComponent(category)}&start_date=${startDate}&end_date=${endDate}&aggregated_by=day`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${SG_KEY}` } });
  if (!res.ok) {
    throw new Error(`SendGrid stats ${res.status}: ${await res.text()}`);
  }
  const data: any = await res.json();
  const totals = empty();
  for (const day of data || []) {
    for (const stat of day.stats || []) {
      const m = stat.metrics || {};
      totals.delivered    += m.delivered     || 0;
      totals.opens        += m.opens         || 0;
      totals.uniqueOpens  += m.unique_opens  || 0;
      totals.clicks       += m.clicks        || 0;
      totals.uniqueClicks += m.unique_clicks || 0;
      totals.bounces      += m.bounces       || 0;
      totals.spamReports  += m.spam_reports  || 0;
      totals.unsubscribes += m.unsubscribes  || 0;
      totals.requests     += m.requests      || 0;
    }
  }
  return totals;
}

function fmtRate(num: number, denom: number): string {
  if (denom === 0) return '—';
  return `${((num / denom) * 100).toFixed(1)}%`;
}

function statRow(label: string, b: StatBucket): string {
  return `<tr>
<td style="padding:8px 12px;border-bottom:1px solid #eee;"><strong>${label}</strong></td>
<td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${b.requests}</td>
<td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${b.delivered}</td>
<td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${b.uniqueOpens}<br><small style="color:#666;">${fmtRate(b.uniqueOpens, b.delivered)}</small></td>
<td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${b.uniqueClicks}<br><small style="color:#666;">${fmtRate(b.uniqueClicks, b.delivered)}</small></td>
<td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:${b.bounces > 0 ? '#dc2626' : '#999'};">${b.bounces}</td>
<td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:${b.spamReports > 0 ? '#dc2626' : '#999'};">${b.spamReports}</td>
<td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:${b.unsubscribes > 0 ? '#d97706' : '#999'};">${b.unsubscribes}</td>
</tr>`;
}

function buildReport(yesterday: { lenders: StatBucket; compliance: StatBucket; umbrella: StatBucket }, cumulative: { lenders: StatBucket; compliance: StatBucket; umbrella: StatBucket }, dateLabel: string, sentLogSummary: string): string {
  const yOpenRate = fmtRate(yesterday.umbrella.uniqueOpens, yesterday.umbrella.delivered);
  const yClickRate = fmtRate(yesterday.umbrella.uniqueClicks, yesterday.umbrella.delivered);
  const cumOpenRate = fmtRate(cumulative.umbrella.uniqueOpens, cumulative.umbrella.delivered);
  const cumClickRate = fmtRate(cumulative.umbrella.uniqueClicks, cumulative.umbrella.delivered);
  // Heuristics for a quick "what should you tweak" callout
  const callouts: string[] = [];
  if (cumulative.umbrella.delivered >= 25) {
    const openRate = cumulative.umbrella.uniqueOpens / cumulative.umbrella.delivered;
    if (openRate < 0.20) callouts.push('Open rate below 20% across the campaign — consider testing a shorter, less newsletter-y subject line.');
    else if (openRate >= 0.30) callouts.push('Open rate above 30% — current subject line is working, hold the line.');
    if (cumulative.umbrella.delivered > 0 && cumulative.umbrella.uniqueClicks / cumulative.umbrella.delivered < 0.03) {
      callouts.push('Click-through below 3% — the body copy may be burying the CTA. Consider moving the trial signup button higher.');
    }
    if (cumulative.umbrella.unsubscribes > 0 && cumulative.umbrella.unsubscribes / cumulative.umbrella.delivered > 0.02) {
      callouts.push(`Unsubscribe rate ${fmtRate(cumulative.umbrella.unsubscribes, cumulative.umbrella.delivered)} — running hot. Consider tightening targeting or tone.`);
    }
    if (cumulative.umbrella.spamReports > 0) {
      callouts.push(`${cumulative.umbrella.spamReports} spam reports flagged — pause sending and review with deliverability before next batch.`);
    }
  }
  const calloutHtml = callouts.length === 0
    ? '<p style="color:#888;font-style:italic;">No automated optimization callouts yet (need 25+ delivered for signal).</p>'
    : '<ul style="margin:0;padding-left:20px;line-height:1.7;">' + callouts.map(c => `<li>${c}</li>`).join('') + '</ul>';

  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;max-width:720px;margin:0 auto;padding:24px;line-height:1.55;">
<h2 style="margin:0 0 4px 0;">May 2026 Marketing - Daily Stats</h2>
<p style="color:#666;margin:0 0 24px 0;">${dateLabel}</p>

<div style="background:#f0fdf4;border-left:4px solid #00C48C;padding:14px 18px;margin:0 0 24px 0;border-radius:4px;font-size:14px;">
<strong>Yesterday at a glance:</strong> ${yesterday.umbrella.delivered} delivered &middot; ${yOpenRate} opens &middot; ${yClickRate} clicks
&nbsp; |&nbsp; <strong>Campaign-to-date:</strong> ${cumulative.umbrella.delivered} delivered &middot; ${cumOpenRate} opens &middot; ${cumClickRate} clicks
</div>

<h3 style="font-size:16px;margin:24px 0 8px 0;">Yesterday (last 24h)</h3>
<table style="width:100%;border-collapse:collapse;font-size:13px;">
<thead><tr style="background:#f5f5f5;">
<th style="padding:8px 12px;text-align:left;">Segment</th>
<th style="padding:8px 12px;text-align:right;">Sent</th>
<th style="padding:8px 12px;text-align:right;">Delivered</th>
<th style="padding:8px 12px;text-align:right;">Opens</th>
<th style="padding:8px 12px;text-align:right;">Clicks</th>
<th style="padding:8px 12px;text-align:right;">Bounces</th>
<th style="padding:8px 12px;text-align:right;">Spam</th>
<th style="padding:8px 12px;text-align:right;">Unsubs</th>
</tr></thead>
<tbody>
${statRow('Lenders', yesterday.lenders)}
${statRow('Compliance', yesterday.compliance)}
${statRow('All', yesterday.umbrella)}
</tbody>
</table>

<h3 style="font-size:16px;margin:32px 0 8px 0;">Campaign-to-date</h3>
<table style="width:100%;border-collapse:collapse;font-size:13px;">
<thead><tr style="background:#f5f5f5;">
<th style="padding:8px 12px;text-align:left;">Segment</th>
<th style="padding:8px 12px;text-align:right;">Sent</th>
<th style="padding:8px 12px;text-align:right;">Delivered</th>
<th style="padding:8px 12px;text-align:right;">Opens</th>
<th style="padding:8px 12px;text-align:right;">Clicks</th>
<th style="padding:8px 12px;text-align:right;">Bounces</th>
<th style="padding:8px 12px;text-align:right;">Spam</th>
<th style="padding:8px 12px;text-align:right;">Unsubs</th>
</tr></thead>
<tbody>
${statRow('Lenders', cumulative.lenders)}
${statRow('Compliance', cumulative.compliance)}
${statRow('All', cumulative.umbrella)}
</tbody>
</table>

<h3 style="font-size:16px;margin:32px 0 8px 0;">Optimization callouts</h3>
${calloutHtml}

<h3 style="font-size:16px;margin:32px 0 8px 0;">Send queue</h3>
<p style="font-size:14px;color:#444;margin:0;">${sentLogSummary}</p>

<hr style="border:none;border-top:1px solid #eee;margin:32px 0;"/>
<p style="font-size:12px;color:#888;">Detailed event timeline: <a href="https://app.sendgrid.com/email_activity" style="color:#0066cc;">SendGrid Email Activity</a> &nbsp;|&nbsp; Filter by category <code>may2026</code></p>
</body></html>`;
}

async function loadSentLogSummary(): Promise<string> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const sentLogPath = path.join(process.cwd(), 'scripts/data/may2026-sent.json');
  const cachePath = path.join(process.cwd(), 'scripts/data/hubspot-leads-may2026.json');
  let sent: any[] = [];
  let totalAddressable = 0;
  try {
    const log = JSON.parse(await fs.readFile(sentLogPath, 'utf8'));
    sent = log.sent || [];
  } catch {}
  try {
    const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    totalAddressable = (cache.addressable || []).length;
  } catch {}
  const lendersSent = sent.filter(s => s.segment === 'lenders').length;
  const complianceSent = sent.filter(s => s.segment === 'compliance').length;
  const lendersRemaining = Math.max(0, totalAddressable - lendersSent);
  return `<strong>Lenders:</strong> ${lendersSent} sent of ${totalAddressable} addressable (${lendersRemaining} remaining at 25/day = ~${Math.ceil(lendersRemaining / 25)} business days). <strong>Compliance:</strong> ${complianceSent} sent.`;
}

async function main() {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const ymd = (d: Date) => d.toISOString().split('T')[0];
  const yesterdayStr = ymd(yesterday);
  const todayStr = ymd(now);
  // Cumulative window — May 1 through today
  const campaignStart = '2026-05-01';

  console.log(`Fetching SendGrid stats:`);
  console.log(`  Yesterday: ${yesterdayStr} → ${yesterdayStr}`);
  console.log(`  Cumulative: ${campaignStart} → ${todayStr}`);

  const [
    yLenders, yCompliance, yUmbrella,
    cLenders, cCompliance, cUmbrella,
  ] = await Promise.all([
    fetchCategoryStats('lender_reactivation', yesterdayStr, yesterdayStr),
    fetchCategoryStats('compliance_outreach', yesterdayStr, yesterdayStr),
    fetchCategoryStats('may2026', yesterdayStr, yesterdayStr),
    fetchCategoryStats('lender_reactivation', campaignStart, todayStr),
    fetchCategoryStats('compliance_outreach', campaignStart, todayStr),
    fetchCategoryStats('may2026', campaignStart, todayStr),
  ]);

  const sentLogSummary = await loadSentLogSummary();
  const dateLabel = `Report generated ${now.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' })} PT`;

  const html = buildReport(
    { lenders: yLenders, compliance: yCompliance, umbrella: yUmbrella },
    { lenders: cLenders, compliance: cCompliance, umbrella: cUmbrella },
    dateLabel,
    sentLogSummary,
  );

  if (dryRun) {
    const fs = await import('fs/promises');
    await fs.writeFile('/tmp/marketing-daily-report.html', html);
    console.log('Wrote /tmp/marketing-daily-report.html (dry-run)');
    return;
  }

  await sgMail.send({
    to: 'matt@moderntax.io',
    from: { email: 'hello@moderntax.io', name: 'Matt at ModernTax' },
    replyTo: 'hello@moderntax.io',
    subject: `May Marketing — Daily Report (${cUmbrella.delivered} delivered, ${fmtRate(cUmbrella.uniqueOpens, cUmbrella.delivered)} opens)`,
    html,
  });
  console.log('Sent → matt@moderntax.io');
}

main().catch(e => { console.error(e); process.exit(1); });
