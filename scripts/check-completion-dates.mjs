import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data } = await sb.from('request_entities')
  .select('id, entity_name, status, completed_at, requests(client_id, clients(name, slug, free_trial))')
  .or('entity_name.ilike.%KILBURN%,entity_name.ilike.%Mento%');

for (const e of data || []) {
  console.log(`${e.entity_name.padEnd(35)} status=${e.status.padEnd(10)} completed_at=${e.completed_at?.slice(0,19) || 'NULL'} client=${e.requests?.clients?.name} free_trial=${e.requests?.clients?.free_trial}`);
}

// Centerstone client_id from the entity row
const csClientId = data?.find(e => e.requests?.clients?.slug === 'centerstone-sba-lending')?.requests?.client_id;
if (csClientId) {
  const { data: cs } = await sb.from('request_entities')
    .select('id, entity_name, completed_at, requests!inner(client_id)')
    .eq('status', 'completed')
    .eq('requests.client_id', csClientId)
    .gte('completed_at', '2026-05-01')
    .lt('completed_at', '2026-06-01');
  console.log(`\nCenterstone entities completed in May 2026: ${cs?.length || 0}`);
  for (const e of cs || []) {
    console.log(`  · ${e.entity_name.padEnd(40)} ${e.completed_at?.slice(0,19)}`);
  }
}

// Same for TaxTaker
const ttClientId = data?.find(e => e.requests?.clients?.slug === 'taxtaker-inc')?.requests?.client_id;
if (ttClientId) {
  const { data: tt } = await sb.from('request_entities')
    .select('id, entity_name, completed_at, requests!inner(client_id)')
    .eq('status', 'completed')
    .eq('requests.client_id', ttClientId)
    .gte('completed_at', '2026-05-01')
    .lt('completed_at', '2026-06-01');
  console.log(`\nTaxTaker entities completed in May 2026: ${tt?.length || 0}`);
  for (const e of tt || []) {
    console.log(`  · ${e.entity_name.padEnd(40)} ${e.completed_at?.slice(0,19)}`);
  }
}
