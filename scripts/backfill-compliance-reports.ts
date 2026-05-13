#!/usr/bin/env node
/**
 * Backfill: generate the new Tax-Guard-parity Compliance Status Report
 * for every completed entity in production, then group results by
 * client + processor and email each one a summary linking them in.
 *
 * Idempotent: the per-entity URL is the source of truth (page renders
 * live from the transcripts on file), so we don't need to write
 * cached JSON anywhere. This script just emails everyone the
 * deep-links + a count of their entities with active findings.
 *
 * Run with `node scripts/backfill-compliance-reports.mjs [--dry-run]`
 *
 * Dry-run mode (--dry-run): builds the email payload and prints to
 * stdout instead of sending. Use this to verify the per-recipient
 * counts before firing the SendGrid blasts.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import sgMail from '@sendgrid/mail';
import { buildTaxLiabilityReport } from '../lib/tax-liability-report';

const DRY = process.argv.includes('--dry-run');
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const env = Object.fromEntries(
  envText.split('\n')
    .filter(l => l && !l.trim().startsWith('#') && l.includes('='))
    .map(l => { const eq = l.indexOf('='); return [l.slice(0, eq).trim(), l.slice(eq + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const APP_URL = 'https://portal.moderntax.io';

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

async function main() {
// 1) Find every entity with at least one HTML transcript on file.
const { data: entities, error } = await sb
  .from('request_entities')
  .select('id, entity_name, tid, status, completed_at, transcript_html_urls, transcript_urls, request_id, requests(loan_number, client_id, clients(name))')
  .eq('status', 'completed')
  .not('transcript_html_urls', 'eq', '{}')
  .order('completed_at', { ascending: false });
if (error) { console.error('lookup err:', error); process.exit(1); }
console.log(`Pulled ${entities?.length || 0} completed entities with transcripts.\n`);

// 2) For each entity, build the report (so we know severity counts).
//    This is slow because we have to download each HTML — process in
//    batches and accumulate a per-client / per-processor summary.
const perClient = new Map(); // client_id → { name, entities: [{name, id, severity, balance, hasFindings, loan, completedAt}] }

let i = 0;
for (const e of (entities || [])) {
  i++;
  const allUrls = [...new Set([...(e.transcript_urls||[]), ...(e.transcript_html_urls||[])])]
    .filter(u => u.endsWith('.html'));
  const inputs = [];
  for (const u of allUrls) {
    const { data: f, error: dlErr } = await sb.storage.from('uploads').download(u);
    if (dlErr || !f) continue;
    const html = await f.text();
    inputs.push({ source: u.split('/').pop() || u, html });
  }
  if (inputs.length === 0) continue;
  const report = buildTaxLiabilityReport(e.entity_name, e.tid, inputs);
  const clientId = e.requests?.client_id || 'unknown';
  const clientName = e.requests?.clients?.name || 'Unknown';
  if (!perClient.has(clientId)) perClient.set(clientId, { name: clientName, entities: [] });
  perClient.get(clientId).entities.push({
    id: e.id,
    name: e.entity_name,
    severity: report.overallSeverity,
    balance: report.taxLiabilities.totalBalance,
    unfiled: report.filingCompliance.unfiled.length,
    hasFindings: report.overallSeverity !== 'CLEAN',
    loan: e.requests?.loan_number,
    completedAt: e.completed_at,
    headline: report.headlineSummary,
  });
  if (i % 25 === 0) console.log(`  processed ${i}/${entities.length}…`);
}
console.log(`\n✓ Built reports for ${i} entities across ${perClient.size} clients.\n`);

// 3) Group by client → identify the recipients (managers + processors of that client)
//    Send one summary email per recipient with their client's portfolio rollup.
if (env.SENDGRID_API_KEY) sgMail.setApiKey(env.SENDGRID_API_KEY);
const FROM = env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io';

let sent = 0;
for (const [clientId, info] of perClient) {
  // Find recipients: client managers + processors
  const { data: recipients } = await sb
    .from('profiles')
    .select('id, email, full_name, role')
    .eq('client_id', clientId)
    .in('role', ['manager', 'processor', 'team_member'])
    .not('email', 'is', null);

  const findings = info.entities.filter(e => e.hasFindings);
  const clean = info.entities.length - findings.length;
  const totalBalance = info.entities.reduce((s, e) => s + (e.balance || 0), 0);
  const totalUnfiled = info.entities.reduce((s, e) => s + (e.unfiled || 0), 0);

  for (const r of (recipients || [])) {
    const firstName = (r.full_name || r.email || '').split(/[ @]/)[0] || 'there';
    const subject = findings.length > 0
      ? `New Compliance Status Reports — ${findings.length} of ${info.entities.length} entities flagged`
      : `New Compliance Status Reports — ${info.entities.length} entities (all clean)`;

    const rows = findings.slice(0, 25).map(e => {
      const severityChip = e.severity === 'CRITICAL'
        ? '<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">CRITICAL</span>'
        : '<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">WARNING</span>';
      const balanceCell = e.balance > 0
        ? `$${e.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : '—';
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;">${escapeHtml(e.name)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace;">${escapeHtml(e.loan || '')}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${severityChip}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-family:monospace;">${balanceCell}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${e.unfiled > 0 ? e.unfiled : '—'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;"><a href="${APP_URL}/admin/compliance-status/${e.id}" style="color:#00C48C;text-decoration:none;font-weight:600;">View report →</a></td>
      </tr>`;
    }).join('\n');

    const findingsTable = findings.length > 0 ? `
<h3 style="font-size:14px;color:#1a1a1a;margin:24px 0 8px;">Entities with findings</h3>
<table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #eee;border-radius:6px;overflow:hidden;">
  <thead>
    <tr style="background:#f9f9f9;">
      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #00C48C;">Entity</th>
      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #00C48C;">Loan</th>
      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #00C48C;">Severity</th>
      <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #00C48C;">Balance</th>
      <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #00C48C;">Unfiled</th>
      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #00C48C;">Report</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>` : '';

    const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.55;max-width:680px;margin:0 auto;padding:24px;">
<p>Hi ${escapeHtml(firstName)},</p>

<p>We just shipped a new <strong>Compliance Status Report</strong> alongside every IRS transcript pull — at no extra cost. The report bundles three pieces of analysis we used to deliver only on request:</p>

<ol style="padding-left:20px;">
  <li><strong>Filing Compliance</strong> — what's been filed (TC 150) vs. blank "no record" results, by form and period.</li>
  <li><strong>Tax Liabilities by Period</strong> — itemized balance, accruing interest/penalty, and status (open / closed) per quarter or year.</li>
  <li><strong>Repayment Plan Status</strong> — whether an Installment Agreement, Offer in Compromise, or Currently-Not-Collectible status is active, with the recommended next step.</li>
</ol>

<p>This closes the gap between ModernTax and Tax Guard's compliance synthesis — same data, structured for SBA underwriting decisions in one click.</p>

<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin:24px 0;">
  <p style="margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#047857;font-weight:600;">Your portfolio at ${escapeHtml(info.name)}</p>
  <p style="margin:0;font-size:14px;color:#1a1a1a;">
    <strong>${info.entities.length}</strong> completed ${info.entities.length === 1 ? 'entity has' : 'entities have'} compliance reports available.
    ${findings.length > 0 ? `<strong style="color:#92400e;">${findings.length}</strong> have active findings (${totalBalance > 0 ? '$' + totalBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' in open balances' : 'collection / lien / etc.'}${totalUnfiled > 0 ? `, ${totalUnfiled} unfiled returns` : ''}).` : ''}
    ${clean > 0 ? `<strong style="color:#15803d;">${clean}</strong> are clean.` : ''}
  </p>
</div>

${findingsTable}

<p style="margin-top:24px;">Open any "View report →" link above to see the full per-period detail. Reports update automatically when new transcripts come in — no need to re-request.</p>

<p>Reply with feedback if anything looks off, or if you want a specific finding walked through. Banc of California asked for this comparison vs. their prior vendor and we built it; happy to incorporate more of what your underwriting team needs to see.</p>

<p style="margin-top:24px;">Best,<br>Matt Parker<br><span style="font-size:12px;color:#666;">matt@moderntax.io · 650-741-1085</span></p>
</body></html>`;

    if (DRY) {
      console.log(`\n— Would send to: ${r.email} (${r.role}) at ${info.name}`);
      console.log(`  Subject: ${subject}`);
      console.log(`  Entities: ${info.entities.length} total, ${findings.length} with findings, $${totalBalance.toFixed(2)} balance`);
      continue;
    }
    try {
      await sgMail.send({
        to: r.email,
        from: { email: FROM, name: 'ModernTax Notifications' },
        subject,
        html,
        replyTo: 'matt@moderntax.io',
      });
      sent++;
      console.log(`  ✓ ${r.email}  (${info.name}, ${info.entities.length} entities, ${findings.length} flagged)`);
    } catch (err) {
      console.error(`  ✗ ${r.email}: ${err.message}`);
    }
  }
}

console.log(`\n${DRY ? 'DRY RUN — ' : ''}${sent} emails sent.`);
}  // end async main

function escapeHtml(s: unknown): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
