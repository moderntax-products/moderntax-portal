import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data } = await sb.from('request_entities').select('*').limit(1);
console.log('request_entities columns:');
console.log(Object.keys(data[0] || {}).sort().join('\n'));

// Search any client recently created for "Katie" or "Lent"
const { data: katie } = await sb.from('profiles').select('id, email, full_name, role, client_id').or('full_name.ilike.%katie%,full_name.ilike.%lent%,email.ilike.%lent%').limit(5);
console.log('\nProfiles matching Katie / Lent:');
for (const p of katie || []) console.log(`  · ${p.email} · ${p.full_name} · ${p.role} · client_id=${p.client_id}`);

const { data: clientsWithLent } = await sb.from('clients').select('id, name, slug, free_trial, billing_ap_email, domain, created_at').or('name.ilike.%lent%,domain.ilike.%lent%,billing_ap_email.ilike.%lent%').limit(5);
console.log('\nClients matching Lent:');
for (const c of clientsWithLent || []) console.log(`  · ${c.name} · slug=${c.slug} · domain=${c.domain} · created=${c.created_at?.slice(0, 10)}`);

// Most recently created clients (so we can spot her new trial account)
const { data: recentClients } = await sb.from('clients').select('id, name, slug, free_trial, billing_ap_email, domain, created_at').order('created_at', { ascending: false }).limit(5);
console.log('\n5 most recently created clients:');
for (const c of recentClients || []) console.log(`  · ${c.created_at?.slice(0, 19)}  ${c.name} (${c.slug}) · trial=${c.free_trial} · ap_email=${c.billing_ap_email}`);
