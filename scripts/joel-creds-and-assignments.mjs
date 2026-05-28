import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const JOEL_ID = '8487c808'; // prefix; will look up full
const { data: joel } = await sb.from('profiles')
  .select('id, email, full_name, role, caf_number, ptin, phone_number, irs_credentials_updated_at, irs_credentials_consented_at, irs_credentials_used_count')
  .ilike('id', `${JOEL_ID}%`)
  .single();
console.log('Joel profile:');
console.log(JSON.stringify(joel, null, 2));

// Find assignments — try multiple paths
const { data: assn1 } = await sb.from('expert_assignments')
  .select('id, status, assigned_at, entity_id, request_entities(entity_name, status, signed_8821_url)')
  .eq('expert_id', joel.id)
  .order('assigned_at', { ascending: false });
console.log(`\nexpert_assignments where expert_id=${joel.id.slice(0,8)}: ${assn1?.length || 0}`);
for (const a of assn1 || []) {
  const e = a.request_entities;
  console.log(`  · ${(e?.entity_name || '?').padEnd(35)} assn_status=${a.status} entity_status=${e?.status} 8821=${e?.signed_8821_url ? 'YES' : 'no'} assigned=${a.assigned_at?.slice(0,10)}`);
}

// Also check if request_entities has expert_id column directly
const { data: byEntityExpert } = await sb.from('request_entities')
  .select('id, entity_name, status, signed_8821_url')
  .ilike('entity_name', '%Jaykumar%')
  .limit(3);
console.log(`\nJaykumar Patel entity rows: ${byEntityExpert?.length || 0}`);
for (const e of byEntityExpert || []) console.log(`  · ${e.entity_name} status=${e.status} 8821=${e.signed_8821_url ? 'YES' : 'no'} id=${e.id.slice(0,8)}`);

// And check what assignment exists on Jaykumar
if (byEntityExpert?.length) {
  const { data: jpAssn } = await sb.from('expert_assignments')
    .select('id, expert_id, status, assigned_at, profiles!expert_assignments_expert_id_fkey(email, full_name)')
    .eq('entity_id', byEntityExpert[0].id);
  console.log(`\nAssignments on Jaykumar:`);
  for (const a of jpAssn || []) console.log(`  · expert=${a.profiles?.email} (${a.profiles?.full_name}) status=${a.status} assigned=${a.assigned_at?.slice(0,16)}`);
}

// SLA stats: how many 8821_signed entities are stuck > 1 day
const oneDayAgo = new Date(Date.now() - 86400_000).toISOString();
const { data: stuckSigned } = await sb.from('request_entities')
  .select('id, entity_name, status, updated_at, signed_8821_url')
  .eq('status', '8821_signed')
  .lt('updated_at', oneDayAgo);
console.log(`\n8821_signed entities stuck > 1 day: ${stuckSigned?.length || 0}`);
for (const e of (stuckSigned || []).slice(0, 10)) console.log(`  · ${e.entity_name} updated=${e.updated_at?.slice(0,16)}`);
