import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: clients } = await sb.from('clients')
  .select('id, name, contact_email')
  .or('contact_email.ilike.%lent%,name.ilike.%lent%,contact_email.ilike.%katie%');
console.log('Clients matching katie/lent:');
for (const c of clients || []) console.log(`  · ${c.name} <${c.contact_email}> id=${c.id}`);

// Also search submission emails
const { data: subs } = await sb.from('requests')
  .select('id, loan_number, created_at, submitter_email, clients(name)')
  .or('submitter_email.ilike.%katie%,submitter_email.ilike.%lent%')
  .order('created_at', { ascending: false })
  .limit(10);
console.log('\nRequests with katie/lent submitter:');
for (const r of subs || []) console.log(`  · loan=${r.loan_number} client=${r.clients?.name} submitter=${r.submitter_email} created=${r.created_at?.slice(0,19)}`);
