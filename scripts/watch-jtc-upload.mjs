/**
 * Watch JTC Business LLC for the 12 × 941 quarterly transcripts that
 * Matt's uploading right now from SOR. As soon as files land, run the
 * ERC refund-delivery analysis (the same engine that surfaced
 * Mento's $68K undelivered).
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const JTC_ID = '3512b0f6-8689-4c07-b3e3-72ee70752425';

// Expected 12 quarters: Q1 2020 → Q4 2022
const EXPECTED_PERIODS = [
  '03-31-2020', '06-30-2020', '09-30-2020', '12-31-2020',
  '03-31-2021', '06-30-2021', '09-30-2021', '12-31-2021',
  '03-31-2022', '06-30-2022', '09-30-2022', '12-31-2022',
];

const POLL_INTERVAL_MS = 15_000;
const MAX_POLLS = 40; // 10 min total

let last = 0;
for (let i = 0; i < MAX_POLLS; i++) {
  const { data: ent } = await sb.from('request_entities')
    .select('id, entity_name, status, transcript_html_urls, transcript_urls, updated_at, completed_at')
    .eq('id', JTC_ID).single();

  const html = (ent?.transcript_html_urls || []);
  if (html.length !== last) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] JTC has ${html.length} HTML transcripts now (status=${ent?.status})`);
    last = html.length;
  }
  if (html.length >= 12) {
    console.log(`\n✓ All 12 quarters uploaded. Running ERC refund analysis…\n`);
    break;
  }
  if (i < MAX_POLLS - 1) await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
}

const { data: ent } = await sb.from('request_entities')
  .select('id, entity_name, status, transcript_html_urls, transcript_urls, updated_at, completed_at, requests(loan_number, clients(name))')
  .eq('id', JTC_ID).single();

const htmlFiles = (ent.transcript_html_urls || []).filter(u => u.endsWith('.html'));
console.log(`\n${'═'.repeat(80)}`);
console.log(`JTC Business LLC — ERC Refund Delivery Analysis`);
console.log(`Loan ${ent.requests?.loan_number} · ${ent.requests?.clients?.name}`);
console.log(`Status: ${ent.status} · Files: ${htmlFiles.length} (HTML) of expected 12`);
console.log(`${'═'.repeat(80)}\n`);

if (htmlFiles.length === 0) {
  console.log(`No HTML files on JTC yet. SOR upload may still be in progress.`);
  process.exit(0);
}

// Parse + tag each TC 846 / 740 event
const events = [];
const periodsFound = new Set();

for (const u of htmlFiles) {
  const { data: file } = await sb.storage.from('uploads').download(u);
  if (!file) continue;
  const html = Buffer.from(await file.arrayBuffer()).toString('utf8');
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const fname = u.split('/').pop();

  const periodMatch = text.match(/Tax Period (?:Requested|Ending)[:\s]+(\d{2}-\d{2}-\d{4})/i);
  const period = periodMatch?.[1] || '?';
  periodsFound.add(period);

  const formMatch = text.match(/FORM\s+(941|1120|1065|1040)/i);
  const form = formMatch?.[1] || '?';
  if (form !== '941') continue;

  const issued = [...text.matchAll(/846\s+Refund issued\s+(\d{2}-\d{2}-\d{4})\s+(-?\$?[\d,\.]+)/g)];
  const credits = [...text.matchAll(/766\s+Credit to your account\s+(\d{2}-\d{2}-\d{4})\s+(-?\$?[\d,\.]+)/g)];
  const undelivered = [...text.matchAll(/740\s+Undelivered refund returned to IRS\s+(\d{2}-\d{2}-\d{4})\s+(-?\$?[\d,\.]+)/g)];

  for (const t846 of issued) {
    const amt = parseFloat(t846[2].replace(/[$,]/g, ''));
    if (amt <= 0) continue;
    const matched = undelivered.find(t740 => {
      const u740 = parseFloat(t740[2].replace(/[$,]/g, ''));
      return Math.abs(u740) === amt && t740[1] === t846[1];
    });
    events.push({
      period, issuedOn: t846[1], amount: amt,
      status: matched ? 'UNDELIVERED' : 'delivered',
      returnedOn: matched ? matched[1] : null,
      source: fname,
    });
  }

  // Also log unprocessed TC 766 credits (claim still pending agent processing)
  for (const c766 of credits) {
    const amt = Math.abs(parseFloat(c766[2].replace(/[$,]/g, '')));
    if (amt < 100) continue; // skip tiny adjustments
    // Was there a TC 846 issued AFTER this credit? If not, claim is pending
    const hasIssue = issued.some(i => i[1] >= c766[1]);
    if (!hasIssue) {
      events.push({
        period, issuedOn: c766[1], amount: amt,
        status: 'PENDING (TC 766 credit, no TC 846 yet)',
        returnedOn: null, source: fname,
      });
    }
  }
}

// Period coverage
console.log(`ERC quarters with 941 data on file (${periodsFound.size}/12):`);
for (const p of EXPECTED_PERIODS) {
  console.log(`  ${periodsFound.has(p) ? '✓' : '✗'}  ${p}`);
}

if (events.length === 0) {
  console.log(`\n No ERC-related TC 846/766 events found in the 941 transcripts.`);
  console.log(`Either no ERC was claimed on JTC, or the claim is at a pre-credit stage.`);
  process.exit(0);
}

events.sort((a, b) => a.issuedOn.localeCompare(b.issuedOn));

console.log(`\nERC refund events:`);
console.log(`${'─'.repeat(80)}`);
console.log(`Date         Period         Amount         Status`);
console.log(`${'─'.repeat(80)}`);
let totalIssued = 0, totalUndelivered = 0, totalPending = 0;
for (const e of events) {
  const flag = e.status === 'UNDELIVERED' ? '🚨' : e.status.startsWith('PENDING') ? '⏳' : '✓ ';
  console.log(`${e.issuedOn}   ${e.period.padEnd(12)}   $${e.amount.toFixed(2).padStart(11)}    ${flag} ${e.status}${e.returnedOn ? ` (returned ${e.returnedOn})` : ''}`);
  if (e.status === 'UNDELIVERED') { totalIssued += e.amount; totalUndelivered += e.amount; }
  else if (e.status === 'delivered') totalIssued += e.amount;
  else if (e.status.startsWith('PENDING')) totalPending += e.amount;
}
console.log(`${'─'.repeat(80)}\n`);

const totalDelivered = totalIssued - totalUndelivered;
console.log(`Total ERC issued by IRS:           $${totalIssued.toFixed(2)}`);
console.log(`Successfully delivered:            $${totalDelivered.toFixed(2)}`);
console.log(`${totalUndelivered > 0 ? '🚨 ' : ''}Undelivered (recoverable today): $${totalUndelivered.toFixed(2)}`);
if (totalPending > 0) {
  console.log(`⏳ Pending (TC 766, no TC 846 yet):    $${totalPending.toFixed(2)}`);
}

if (totalUndelivered > 0) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`💰 JTC RECOVERY OPPORTUNITY: $${totalUndelivered.toFixed(2)}`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`Same Form 3911 recovery flow as Mento. Loan owner: ${ent.requests?.clients?.name}`);
  console.log(`Bill via the existing $1,000 Mercury invoice for ERC Refund Recovery service.`);
}
