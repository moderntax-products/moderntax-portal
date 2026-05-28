import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Find Katie's client (likely Centerstone or similar) and recent entities
const { data: clients } = await sb.from('clients')
  .select('id, name, contact_email')
  .or('contact_email.ilike.%katie%,name.ilike.%centerstone%,name.ilike.%katie%');
console.log('Possible Katie clients:');
for (const c of clients || []) console.log(`  · ${c.name} <${c.contact_email}> id=${c.id}`);

// Recent submissions in last 48h
const since = new Date(Date.now() - 48 * 3600_000).toISOString();
const { data } = await sb.from('request_entities')
  .select('id, entity_name, status, form_type, years, fiscal_year_end_month, created_at, requests(loan_number, clients(name, contact_email))')
  .gte('created_at', since)
  .order('created_at', { ascending: false })
  .limit(40);

console.log(`\nEntities created in last 48h: ${data?.length || 0}`);
for (const e of data || []) {
  const c = e.requests?.clients;
  console.log(`  · ${(e.entity_name || '').padEnd(34)} fye=${e.fiscal_year_end_month ?? '-'} form=${e.form_type} years=${JSON.stringify(e.years)} status=${e.status} client=${c?.name || '?'} <${c?.contact_email || '?'}>`);
}
