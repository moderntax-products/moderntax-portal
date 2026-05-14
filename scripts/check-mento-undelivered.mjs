import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: ent } = await sb.from('request_entities').select('transcript_html_urls').eq('id', 'f92264b1-d420-4865-93f0-33943fc507ff').single();
const htmls = (ent.transcript_html_urls || []).filter(u => u.endsWith('.html'));

console.log(`\nScanning ${htmls.length} Mento transcripts for refund-issue (TC 846) vs undelivered (TC 740) events:\n`);

const allRefunds = []; // { period, type, date, amount }

for (const u of htmls) {
  const { data: file } = await sb.storage.from('uploads').download(u);
  const html = Buffer.from(await file.arrayBuffer()).toString('utf8');
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const fname = u.split('/').pop();

  const periodMatch = text.match(/Tax Period (?:Requested|Ending)[:\s]+(\d{2}-\d{2}-\d{4})/i);
  const period = periodMatch?.[1] || '?';

  // TC 846 (Refund issued)
  const issued = [...text.matchAll(/846\s+Refund issued\s+(\d{2}-\d{2}-\d{4})\s+(-?\$?[\d,\.]+)/g)];
  for (const m of issued) allRefunds.push({ period, type: '846 Refund issued', date: m[1], amount: m[2], file: fname });

  // TC 740 (Undelivered refund returned to IRS)
  const undel = [...text.matchAll(/740\s+Undelivered refund returned to IRS\s+(\d{2}-\d{2}-\d{4})\s+(-?\$?[\d,\.]+)/g)];
  for (const m of undel) allRefunds.push({ period, type: '740 UNDELIVERED', date: m[1], amount: m[2], file: fname });

  // TC 841 (Refund cancelled — another flavor of "didn't get the money")
  const cancelled = [...text.matchAll(/841\s+(?:Refund c|R)ancell?ed\s+(\d{2}-\d{2}-\d{4})\s+(-?\$?[\d,\.]+)/g)];
  for (const m of cancelled) allRefunds.push({ period, type: '841 REFUND CANCELLED', date: m[1], amount: m[2], file: fname });
}

allRefunds.sort((a, b) => a.date.split('-').reverse().join('').localeCompare(b.date.split('-').reverse().join('')));

console.log(`Date          Quarter         TC                          Amount`);
console.log(`────────────  ──────────────  ──────────────────────────  ─────────────`);
for (const r of allRefunds) {
  console.log(`${r.date}    ${r.period.padEnd(14)}  ${r.type.padEnd(26)}  ${r.amount}`);
}

console.log(`\n=== Net analysis ===\n`);
const issuedTotal = allRefunds.filter(r => r.type.startsWith('846')).reduce((s, r) => s + parseFloat(r.amount.replace(/[$,]/g, '')), 0);
const undeliveredTotal = allRefunds.filter(r => r.type.includes('UNDELIVERED') || r.type.includes('CANCELLED')).reduce((s, r) => s + Math.abs(parseFloat(r.amount.replace(/[$,]/g, ''))), 0);
console.log(`Total refunds ISSUED (TC 846):       $${issuedTotal.toFixed(2)}`);
console.log(`Total refunds UNDELIVERED (TC 740):  $${undeliveredTotal.toFixed(2)}`);
console.log(`Net successfully delivered:           $${(issuedTotal - undeliveredTotal).toFixed(2)}`);
console.log(`Outstanding (needs reissue):          $${undeliveredTotal.toFixed(2)}`);
