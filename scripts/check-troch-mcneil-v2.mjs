import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Try multiple spellings
for (const q of ['%Troch%', '%troch%', '%McNeil%', '%Mc Neil%', '%Mc%Neil%', '%Paving%']) {
  const { data, error } = await sb.from('request_entities')
    .select('id, entity_name, status, fiscal_year_end_month, years')
    .ilike('entity_name', q);
  console.log(`Query "${q}": ${data?.length || 0} rows ${error ? 'ERR='+error.message : ''}`);
  for (const e of (data || []).slice(0, 5)) {
    console.log(`  · "${e.entity_name}" id=${e.id} status=${e.status} fye=${e.fiscal_year_end_month} years=${JSON.stringify(e.years)}`);
  }
}

// Also list Growth Corp client + recent entities
const { data: gc } = await sb.from('clients')
  .select('id, name, contact_email')
  .ilike('name', '%Growth%');
console.log(`\nGrowth Corp clients:`);
for (const c of gc || []) console.log(`  · ${c.name} <${c.contact_email}> id=${c.id}`);

if (gc && gc.length) {
  for (const c of gc) {
    const { data: ents } = await sb.from('request_entities')
      .select('id, entity_name, status, fiscal_year_end_month, years, created_at, requests!inner(client_id, loan_number)')
      .eq('requests.client_id', c.id)
      .order('created_at', { ascending: false })
      .limit(20);
    console.log(`\nEntities for ${c.name}: ${ents?.length || 0}`);
    for (const e of ents || []) {
      console.log(`  · "${e.entity_name}" status=${e.status} fye=${e.fiscal_year_end_month} years=${JSON.stringify(e.years)} loan=${e.requests?.loan_number} created=${e.created_at?.slice(0,19)}`);
    }
  }
}
