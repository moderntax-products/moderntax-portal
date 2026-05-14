import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const entityId = 'f92264b1-d420-4865-93f0-33943fc507ff'; // Mento Technologies

const { data: ent } = await sb.from('request_entities')
  .select('id, entity_name, tid, transcript_html_urls')
  .eq('id', entityId).single();

const htmlUrls = (ent.transcript_html_urls || []).filter(u => u.endsWith('.html'));

console.log(`\n=== Per-file coverage scan for Mento ===\n`);
const coverage = []; // [{ filename, period, form, tcs, refund, balance }]

for (const u of htmlUrls) {
  const { data: file } = await sb.storage.from('uploads').download(u);
  if (!file) continue;
  const html = Buffer.from(await file.arrayBuffer()).toString('utf8');
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const fname = u.split('/').pop();

  // Period: "Tax Period Requested: MM-DD-YYYY" or "Tax Period Ending: MM-DD-YYYY"
  const periodMatch = text.match(/Tax Period (?:Requested|Ending)[:\s]+(\d{2}-\d{2}-\d{4})/i);
  const period = periodMatch?.[1] || null;

  // Form: header has "FORM 941"
  const formMatch = text.match(/FORM\s+(\d{3,4}-?\w?)/i);
  const form = formMatch?.[1] || null;

  // ERC-relevant TCs
  const tcMatches = [...text.matchAll(/\b(150|290|291|420|460|670|766|767|846|971|976|977)\s+([A-Za-z][A-Za-z\s/]+?)\s+\d{2}-\d{2}-\d{4}/g)];
  const tcs = tcMatches.map(m => `${m[1]} ${m[2].trim().slice(0, 40)}`);

  // Refund amount (TC 846)
  const refundMatch = text.match(/846 Refund issued[\s\S]{0,80}?\$?(-?[\d,\.]+)/i);
  const refund = refundMatch?.[1] || null;

  // Account balance
  const balanceMatch = text.match(/ACCOUNT BALANCE:?\s*\$?(-?[\d,\.]+)/i);
  const balance = balanceMatch?.[1] || null;

  coverage.push({ filename: fname, period, form, tcs, refund, balance });
}

// Sort by period date
coverage.sort((a, b) => (a.period || '').localeCompare(b.period || ''));

for (const c of coverage) {
  console.log(`File:    ${c.filename}`);
  console.log(`  Period:       ${c.period || '?'} (form ${c.form || '?'})`);
  console.log(`  Balance:      $${c.balance || '0.00'}`);
  if (c.refund) console.log(`  Refund (846): $${c.refund}`);
  if (c.tcs.length) {
    console.log(`  TCs:`);
    for (const tc of c.tcs.slice(0, 6)) console.log(`    · ${tc}`);
  }
  console.log();
}

// ─── ERC timeline gap analysis ──────────────────────────────────────────
const ercQuarters = [
  { quarter: 'Q2 2020', period: '06-30-2020' },
  { quarter: 'Q3 2020', period: '09-30-2020' },
  { quarter: 'Q4 2020', period: '12-31-2020' },
  { quarter: 'Q1 2021', period: '03-31-2021' },
  { quarter: 'Q2 2021', period: '06-30-2021' },
  { quarter: 'Q3 2021', period: '09-30-2021' },
  { quarter: 'Q4 2021', period: '12-31-2021' },
];
const periodsOnFile = new Set(coverage.map(c => c.period).filter(Boolean));

console.log(`=== ERC timeline gap (RSB = all 7 quarters Q2 2020 → Q4 2021) ===\n`);
let onFile = 0, missing = 0;
for (const q of ercQuarters) {
  const have = periodsOnFile.has(q.period);
  console.log(`  ${have ? '✓' : '✗'}  ${q.quarter.padEnd(8)} (period ${q.period})  ${have ? 'on file' : 'MISSING'}`);
  if (have) onFile++; else missing++;
}
console.log(`\nOn file: ${onFile}/7   Missing: ${missing}/7`);
