import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data } = await sb.from('request_entities')
  .select('id, entity_name, tid, status, signed_8821_url, form_type, years')
  .or('entity_name.ilike.%KILBURN%,entity_name.ilike.%Mento%,entity_name.ilike.%MaxMart%')
  .order('entity_name');

for (const e of data || []) {
  console.log(`${e.entity_name.padEnd(35)} status=${(e.status || '?').padEnd(15)} 8821=${e.signed_8821_url ? 'YES' : 'no '} form=${e.form_type} years=${JSON.stringify(e.years)}`);
}
