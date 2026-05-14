/**
 * Surface the freshly-pulled IRS transcripts for the iCloud expert
 * (matthewaparker@icloud.com) and run the ERC refund-delivery analysis
 * on whichever entity got the pull. Matt requested ERC payroll-year
 * 941s as a "bonus" during a live IRS PPS call that got disconnected
 * after one entity — we want to immediately see if any undelivered
 * refunds surface.
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

// 1. Find the entity touched most recently for the iCloud expert
const ICLOUD = 'bd374d60-5146-4ca9-90e6-29af28af641f';
const { data: assignments } = await sb
  .from('expert_assignments')
  .select('id, entity_id, status, assigned_at, request_entities(id, entity_name, tid, form_type, status, updated_at, completed_at, transcript_html_urls)')
  .eq('expert_id', ICLOUD)
  .order('assigned_at', { ascending: false })
  .limit(10);

// Sort entities by their entity-row updated_at (when transcripts land, updated_at bumps)
const ranked = (assignments || [])
  .map(a => a.request_entities)
  .filter(Boolean)
  .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));

console.log(`\n5 most recently touched entities for iCloud expert (newest first):\n`);
for (const e of ranked.slice(0, 5)) {
  const fileCount = (e.transcript_html_urls || []).length;
  console.log(`  ${e.updated_at?.slice(0, 19)}  ${e.entity_name.padEnd(28)} ${e.tid}  status=${e.status}  files=${fileCount}`);
}

// Target = the one with the most transcript files (most recent pull)
const target = ranked.find(e => (e.transcript_html_urls || []).length > 0) || ranked[0];
if (!target) {
  console.error('No entities found for iCloud expert.');
  process.exit(1);
}

const allFiles = target.transcript_html_urls || [];
const fresh = allFiles.filter(u => {
  const ts = parseInt(u.split('/').pop()?.match(/^(\d{13})/)?.[1] || '0');
  return ts > Date.now() - 4 * 60 * 60 * 1000; // last 4 hours
});

console.log(`\n${'═'.repeat(80)}`);
console.log(`Target entity: ${target.entity_name} (${target.tid})`);
console.log(`Status: ${target.status} · Total files: ${allFiles.length} · Files in last 4 hours: ${fresh.length}`);
console.log(`${'═'.repeat(80)}\n`);

if (allFiles.length === 0) {
  console.log(`No transcript files on this entity yet. The expert pull may still be in transit (fax/email delivery typically lags 5-60 min after the IRS agent reads them).\n`);
  console.log(`Check 415-900-4436 inbox for inbound faxes from IRS, or the expert upload queue at /admin/expert-uploads.`);
  process.exit(0);
}

// 2. For each file, parse for 846/740 events (the ERC refund engine signature)
console.log(`Scanning ${allFiles.length} transcripts for ERC refund-delivery events (TC 846 + TC 740 pairs):\n`);

const events = []; // { period, issuedOn, amount, status, returnedOn, source }
let totalIssued = 0, totalUndelivered = 0;
const periodsScanned = new Set();

for (const u of allFiles.filter(p => p.endsWith('.html'))) {
  const { data: file } = await sb.storage.from('uploads').download(u);
  if (!file) continue;
  const html = Buffer.from(await file.arrayBuffer()).toString('utf8');
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const fname = u.split('/').pop();

  const periodMatch = text.match(/Tax Period (?:Requested|Ending)[:\s]+(\d{2}-\d{2}-\d{4})/i);
  const period = periodMatch?.[1] || '?';
  const formMatch = text.match(/FORM\s+(941|1120|1065|1040)/i);
  const form = formMatch?.[1] || '?';

  if (form !== '941') continue;
  periodsScanned.add(period);

  // TC 846 (refund issued)
  const issued = [...text.matchAll(/846\s+Refund issued\s+(\d{2}-\d{2}-\d{4})\s+(-?\$?[\d,\.]+)/g)];
  // TC 740 (undelivered refund returned to IRS)
  const undelivered = [...text.matchAll(/740\s+Undelivered refund returned to IRS\s+(\d{2}-\d{2}-\d{4})\s+(-?\$?[\d,\.]+)/g)];

  for (const t846 of issued) {
    const amt = parseFloat(t846[2].replace(/[$,]/g, ''));
    if (amt <= 0) continue;
    const matched = undelivered.find(t740 => {
      const u = parseFloat(t740[2].replace(/[$,]/g, ''));
      return Math.abs(u) === amt && t740[1] === t846[1];
    });
    events.push({
      period,
      issuedOn: t846[1],
      amount: amt,
      status: matched ? 'UNDELIVERED' : 'delivered',
      returnedOn: matched ? matched[1] : null,
      source: fname,
    });
    totalIssued += amt;
    if (matched) totalUndelivered += amt;
  }
}

// 3. Report
console.log(`Quarters with 941 data on file: ${periodsScanned.size}`);
console.log(`  ${[...periodsScanned].sort().join(', ')}\n`);

events.sort((a, b) => a.issuedOn.localeCompare(b.issuedOn));

if (events.length === 0) {
  console.log(`✓ No TC 846 refund-issued events found in the 941 transcripts. Either:`);
  console.log(`  - No ERC was claimed on this entity`);
  console.log(`  - Claim is still pending (TC 766 credit but no TC 846 yet)`);
  console.log(`  - Transcripts may not have landed yet — check fax inbox`);
  process.exit(0);
}

console.log(`ERC refund delivery analysis:`);
console.log(`${'─'.repeat(80)}`);
console.log(`Date         Period         Amount        Status`);
console.log(`${'─'.repeat(80)}`);
for (const e of events) {
  const flag = e.status === 'UNDELIVERED' ? '🚨' : '✓ ';
  console.log(`${e.issuedOn}   ${e.period.padEnd(12)}   $${e.amount.toFixed(2).padStart(11)}    ${flag} ${e.status}${e.returnedOn ? ` (returned ${e.returnedOn})` : ''}`);
}
console.log(`${'─'.repeat(80)}\n`);

const totalDelivered = totalIssued - totalUndelivered;
console.log(`Total ERC issued by IRS:           $${totalIssued.toFixed(2)}`);
console.log(`Successfully delivered:            $${totalDelivered.toFixed(2)}`);
console.log(`${totalUndelivered > 0 ? '🚨 ' : ''}Undelivered (recoverable today): $${totalUndelivered.toFixed(2)}`);

if (totalUndelivered > 0) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`💰 RECOVERY OPPORTUNITY: $${totalUndelivered.toFixed(2)}`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`Same pattern as Mento Technologies — refund(s) issued by IRS but returned`);
  console.log(`undelivered (TC 740). Sitting in the entity's IRS account, recoverable via`);
  console.log(`Form 3911 reissue request OR POA-authorized PPS call.`);
  console.log(`\nRecommended: bill Centerstone / TaxTaker / Growth Corp (whoever owns this`);
  console.log(`entity) for the $1,000 Mercury ERC Recovery service that's already wired up.`);
  console.log(`Mercury link: https://app.mercury.com/pay/nb8d2v9bh1dy07tz`);
}
