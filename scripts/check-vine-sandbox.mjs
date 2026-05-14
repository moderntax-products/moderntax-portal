import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: c } = await sb.from('clients').select('id').eq('slug', 'vine-sandbox').single();
const { data: reqs } = await sb.from('requests').select('id, loan_number, status').eq('client_id', c.id);
console.log('Requests:', reqs);
const { data: ents } = await sb.from('request_entities').select('id, entity_name, tid, form_type, status, transcript_html_urls, transcript_urls').in('request_id', (reqs || []).map(r => r.id));
console.log('\nEntities:');
for (const e of ents || []) console.log(`  ${e.entity_name} (${e.tid}) — ${e.form_type} — ${e.status} — html=${(e.transcript_html_urls || []).length} pdf=${(e.transcript_urls || []).length}`);
