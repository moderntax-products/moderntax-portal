import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Find Joel
const { data: joel } = await sb.from('profiles').select('*').or('email.ilike.%joel%,full_name.ilike.%joel%,full_name.ilike.%abernathy%');
console.log(`Joel profiles: ${joel?.length || 0}`);
for (const p of joel || []) {
  console.log(`  · ${p.email} | ${p.full_name} | role=${p.role} | id=${p.id.slice(0,8)}`);
  console.log(`    cols:`, Object.keys(p).filter(k => k.includes('cred') || k.includes('caf') || k.includes('ptin') || k.includes('phone') || k.includes('encrypted')));
}

// Look for expert_credentials table
const { data: creds, error } = await sb.from('expert_credentials').select('*').limit(5);
console.log(`\nexpert_credentials table: ${error ? `ERR ${error.message}` : `${creds?.length || 0} rows`}`);
if (creds) for (const c of creds.slice(0,3)) console.log(`  cols:`, Object.keys(c));

// Find Joel's assignments
const joelId = joel?.[0]?.id;
if (joelId) {
  const { data: assn } = await sb.from('expert_assignments')
    .select('id, status, assigned_at, entity_id, request_entities(entity_name, status, signed_8821_url, signed_8821_uploaded_by_expert)')
    .eq('expert_id', joelId)
    .order('assigned_at', { ascending: false }).limit(20);
  console.log(`\nJoel's assignments: ${assn?.length || 0}`);
  for (const a of assn || []) {
    const e = a.request_entities;
    console.log(`  · ${e?.entity_name?.padEnd(35)} status=${a.status} entity_status=${e?.status} 8821=${e?.signed_8821_url ? 'YES' : 'no'} assigned=${a.assigned_at?.slice(0,10)}`);
  }
}
