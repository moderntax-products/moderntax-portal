import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: ent } = await sb.from('request_entities').select('transcript_html_urls').eq('id', '3512b0f6-8689-4c07-b3e3-72ee70752425').single();
const files = ent.transcript_html_urls || [];

console.log(`Files on JTC (${files.length} total):\n`);
for (const u of files) {
  const fname = u.split('/').pop();
  console.log(`  ${fname}`);
}

console.log(`\n${'═'.repeat(80)}`);
console.log(`Per-file deep scan — every TC 846/766/740/971 event (any quarter, any form):`);
console.log(`${'═'.repeat(80)}\n`);

const allEvents = [];

for (const u of files.filter(p => p.endsWith('.html'))) {
  const { data: file } = await sb.storage.from('uploads').download(u);
  if (!file) continue;
  const html = Buffer.from(await file.arrayBuffer()).toString('utf8');
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const fname = u.split('/').pop();

  // Try multiple period-extraction patterns
  const periodMatch =
    text.match(/Tax Period (?:Requested|Ending)[:\s]+(\d{2}-\d{2}-\d{4})/i) ||
    text.match(/(?:Period|For)[:\s]+(\d{2}-\d{2}-\d{4})/i) ||
    text.match(/(\d{2}-\d{2}-20\d{2})/);
  const period = periodMatch?.[1] || '?';

  const formMatch = text.match(/FORM\s+(941|1120|1065|1040)|Form Number[:\s]+(\d{3,4}[A-Z]?)/i);
  const form = formMatch?.[1] || formMatch?.[2] || '?';

  // Wider TC scan
  const tcMatches = [...text.matchAll(/\b(150|290|291|298|420|460|570|650|660|670|740|766|767|776|777|846|960|971|976|977)\s+([A-Za-z][A-Za-z0-9 \/'-]{5,80})\s+(\d{2}-\d{2}-\d{4})\s+(-?\$?[\d,\.]+)?/g)];

  console.log(`File: ${fname}`);
  console.log(`  period=${period}  form=${form}  TC events found=${tcMatches.length}`);
  for (const m of tcMatches) {
    const code = m[1];
    const desc = m[2].trim().slice(0, 50);
    const date = m[3];
    const amt = m[4] || '';
    if (['846','766','740','971','290','670','660'].includes(code)) {
      console.log(`    · TC ${code}: ${desc.padEnd(50)} ${date}  ${amt}`);
      allEvents.push({ period, form, code, desc, date, amt, source: fname });
    }
  }
  console.log();
}

// Refund delivery summary
console.log(`${'═'.repeat(80)}`);
console.log(`Refund / payment events across all JTC 941 transcripts:`);
console.log(`${'═'.repeat(80)}\n`);

const refundEvents = allEvents.filter(e => ['846', '740', '766'].includes(e.code));
if (refundEvents.length === 0) {
  console.log(`No TC 846 / TC 740 / TC 766 events found anywhere in JTC's 941 transcripts.`);
  console.log(`Conclusion: JTC did NOT claim ERC. No refund-recovery opportunity.`);
} else {
  refundEvents.sort((a, b) => a.date.localeCompare(b.date));
  for (const e of refundEvents) {
    const flag = e.code === '740' ? '🚨' : '  ';
    console.log(`${flag} ${e.date}  TC ${e.code}  period=${e.period}  ${e.amt.padStart(12)}  ${e.desc}`);
  }
}

// Other notable findings
const otherFlags = allEvents.filter(e => ['290', '420', '570'].includes(e.code) && parseFloat(String(e.amt).replace(/[$,]/g, '')) > 0);
if (otherFlags.length > 0) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`Other compliance findings on JTC:`);
  console.log(`${'═'.repeat(80)}`);
  for (const e of otherFlags) {
    console.log(`  ${e.date}  TC ${e.code}  period=${e.period}  ${e.amt.padStart(12)}  ${e.desc}`);
  }
}
