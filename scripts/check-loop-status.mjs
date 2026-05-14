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

console.log(`\nMento transcripts on file: ${htmls.length}\n`);
for (const u of htmls) {
  const { data: file } = await sb.storage.from('uploads').download(u);
  const html = Buffer.from(await file.arrayBuffer()).toString('utf8');
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const fname = u.split('/').pop();
  // ALL tax periods mentioned in this file
  const periodMatches = [...text.matchAll(/Tax Period (?:Requested|Ending)[:\s]+(\d{2}-\d{2}-\d{4})/gi)];
  const periods = [...new Set(periodMatches.map(m => m[1]))];
  // ALL TC codes with dates (real transaction rows, not metadata)
  const tcMatches = [...text.matchAll(/\b(150|290|291|420|460|470|670|766|767|846|971|976|977)\s+([A-Za-z][A-Za-z\s/'-]{5,60})\s+(\d{8}|\d{2}-\d{2}-\d{4})\s+(-?\$?[\d,\.]+)?/g)];
  const tcs = tcMatches.map(m => ({ code: m[1], desc: m[2].trim().slice(0, 45), date: m[3], amt: m[4] || '' }));

  console.log(`File: ${fname}`);
  console.log(`  Periods mentioned: ${periods.join(', ') || '—'}`);
  console.log(`  TCs (${tcs.length}):`);
  for (const tc of tcs.slice(0, 10)) {
    console.log(`    · ${tc.code}  ${tc.desc.padEnd(45)}  ${tc.date.padEnd(11)}  ${tc.amt}`);
  }
  console.log();
}
