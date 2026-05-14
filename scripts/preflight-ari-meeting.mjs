/**
 * Pre-flight check before Matt's Ari (TaxTaker) meeting.
 *
 * 1. Confirms Mento's compliance report data is intact on the admin page
 *    Matt will share-screen — pulls the same synthesis the page renders.
 * 2. Prints the exact URLs + payment links Matt needs in the call.
 * 3. Surfaces the key numbers to keep on hand.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const MENTO_ID = 'f92264b1-d420-4865-93f0-33943fc507ff';

// Pull Mento entity + transcripts
const { data: ent } = await sb.from('request_entities')
  .select('id, entity_name, tid, form_type, status, completed_at, transcript_html_urls, request_id, requests(loan_number)')
  .eq('id', MENTO_ID).single();

const htmls = (ent.transcript_html_urls || []).filter(u => u.endsWith('.html'));

// Aggregate the killer findings: undelivered refunds + unfiled 1120s
let totalIssued = 0;
let totalUndelivered = 0;
const undeliveredEvents = [];
const unfiledForms = [];
const refundsByQuarter = {};

for (const u of htmls) {
  const { data: file } = await sb.storage.from('uploads').download(u);
  const html = Buffer.from(await file.arrayBuffer()).toString('utf8');
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const fname = u.split('/').pop();

  const periodMatch = text.match(/Tax Period (?:Requested|Ending)[:\s]+(\d{2}-\d{2}-\d{4})/i);
  const period = periodMatch?.[1] || '?';
  const formMatch = text.match(/Form Number[:\s]+(\d{4}|941|1120|1040|1065)/i);
  const form = formMatch?.[1] || '?';

  // TC 846 (refund issued) — Q3 2021 had two: one for $35K, then small follow-up
  const issued = [...text.matchAll(/846\s+Refund issued\s+(\d{2}-\d{2}-\d{4})\s+(-?\$?[\d,\.]+)/g)];
  // TC 740 (undelivered refund returned to IRS)
  const undel = [...text.matchAll(/740\s+Undelivered refund returned to IRS\s+(\d{2}-\d{2}-\d{4})\s+(-?\$?[\d,\.]+)/g)];

  for (const m of issued) {
    const amt = parseFloat(m[2].replace(/[$,]/g, ''));
    totalIssued += amt;
    refundsByQuarter[period] = (refundsByQuarter[period] || 0) + amt;
  }
  for (const m of undel) {
    const amt = Math.abs(parseFloat(m[2].replace(/[$,]/g, '')));
    totalUndelivered += amt;
    undeliveredEvents.push({ period, date: m[1], amount: amt });
  }

  // Check for TC 150 (return filed) — absence on 1120 = unfiled
  if (form === '1120') {
    const has150 = /\b150\s+Tax return filed/.test(text);
    const has460 = /\b460\s+Extension of time to file/.test(text);
    if (!has150 && has460) {
      unfiledForms.push({ form: '1120', period, sourceFile: fname });
    }
  }
}

console.log(`\n${'═'.repeat(80)}`);
console.log(`PRE-FLIGHT — Mento Technologies, Inc. (TaxTaker · Ari Salafia)`);
console.log(`${'═'.repeat(80)}\n`);

console.log(`Entity: ${ent.entity_name}`);
console.log(`EIN:    84-${ent.tid}`);
console.log(`Status: ${ent.status} · Completed: ${ent.completed_at?.slice(0, 19)}`);
console.log(`Loan #: ${ent.requests?.loan_number}`);
console.log(`Files on record: ${htmls.length}\n`);

console.log(`─── THE KILLER FINDINGS (keep these numbers handy) ─────────────────────────────\n`);
console.log(`  Total ERC issued by IRS:             $${totalIssued.toFixed(2)}`);
console.log(`  Successfully delivered:              $${(totalIssued - totalUndelivered).toFixed(2)}`);
console.log(`  UNDELIVERED (recoverable today):     $${totalUndelivered.toFixed(2)}`);
console.log();
console.log(`  Undelivered refund events:`);
for (const e of undeliveredEvents) {
  console.log(`    · ${e.period.padEnd(12)} ${e.date}  $${e.amount.toFixed(2).padStart(10)}  (TC 740 — returned to IRS)`);
}
console.log();
console.log(`  Unfiled 1120 returns (audit-defense gap):`);
for (const f of unfiledForms) {
  console.log(`    · ${f.form} period ${f.period} — TC 460 (extension) on file, no TC 150 (return filed)`);
}

console.log(`\n─── ADMIN PAGE URL FOR SHARE-SCREEN ────────────────────────────────────────────\n`);
console.log(`  https://portal.moderntax.io/admin/compliance-status/${MENTO_ID}\n`);
console.log(`  This page renders:`);
console.log(`    · Filing Compliance (filed vs unfiled — the unfiled 1120s show here)`);
console.log(`    · Tax Liabilities (per-period balances + accruals)`);
console.log(`    · Federal Tax Payments (TC 670 history)`);
console.log(`    · Extensions, Amendments & Audits (TC 460 / 977 / 290 / 420)`);
console.log(`    · Repayment Plan recommendation`);

console.log(`\n─── PAYMENT LINKS (drop into chat at the right moment) ─────────────────────────\n`);
console.log(`  Bundle C (ERC discovery — $479):`);
console.log(`    https://buy.stripe.com/28E6oG9nB0iu0l0fPqco01n\n`);
console.log(`  ERC Refund Recovery (Form 3911s — $1,000):`);
console.log(`    https://app.mercury.com/pay/nb8d2v9bh1dy07tz`);

console.log(`\n${'═'.repeat(80)}\n`);
