import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Find entities with FYE = 2 (Feb) or referenced as 2/28
const { data } = await sb.from('request_entities')
  .select('id, entity_name, status, form_type, years, fiscal_year_end_month, signed_8821_url, requests(loan_number, clients(name))')
  .eq('fiscal_year_end_month', 2)
  .order('entity_name');

console.log(`Entities with FYE=2 (Feb / 2-28): ${data?.length || 0}\n`);
for (const e of data || []) {
  console.log(`  · ${e.entity_name.padEnd(35)} status=${e.status} form=${e.form_type} years=${JSON.stringify(e.years)} client=${e.requests?.clients?.name} loan=${e.requests?.loan_number} 8821=${e.signed_8821_url ? 'Y' : 'n'}`);
}
