import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Use tsx directly to execute the TS module
const { filterRequestedTranscripts, formatInternalPullsNote } = await import('../lib/transcript-filter.ts');

const { data: ent } = await sb.from('request_entities')
  .select('entity_name, form_type, years, transcript_html_urls, transcript_urls')
  .eq('id', '3512b0f6-8689-4c07-b3e3-72ee70752425').single();

const allUrls = [...new Set([...(ent.transcript_urls || []), ...(ent.transcript_html_urls || [])])];
console.log(`\n${ent.entity_name}: ${allUrls.length} unique files in DB`);
console.log(`Requested: form ${ent.form_type}, years [${(ent.years || []).join(', ')}]\n`);

const result = filterRequestedTranscripts(allUrls, ent.form_type, ent.years);

console.log(`\n✓ PROCESSOR SEES (${result.requested.length} files):`);
for (const u of result.requested) console.log(`  ${u.split('/').pop()}`);

console.log(`\n✗ INTERNAL ONLY (${result.internalOnly.length} files):`);
for (const u of result.internalOnly) console.log(`  ${u.split('/').pop()}`);

console.log(`\nInternal note shown to processor:`);
console.log(`  "${formatInternalPullsNote(result.internalSummary) || '(none)'}"`);
console.log(`\nSummary: bonusErcSweep=${result.internalSummary.bonusErcSweep}, differentForm=${result.internalSummary.differentForm}, yearOutOfScope=${result.internalSummary.yearOutOfScope}`);
