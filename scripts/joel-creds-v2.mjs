import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: joel } = await sb.from('profiles')
  .select('id, email, full_name, role, caf_number, ptin, phone_number, irs_credentials_updated_at, irs_credentials_consented_at, irs_credentials_used_count')
  .eq('email', 'joelsteven@earthlink.net')
  .single();
console.log('Joel profile:');
console.log(JSON.stringify(joel, null, 2));

if (joel) {
  const { data: assn1 } = await sb.from('expert_assignments')
    .select('id, status, assigned_at, request_entities(entity_name, status, signed_8821_url)')
    .eq('expert_id', joel.id)
    .order('assigned_at', { ascending: false }).limit(10);
  console.log(`\nAssignments: ${assn1?.length || 0}`);
  for (const a of assn1 || []) {
    const e = a.request_entities;
    console.log(`  · ${(e?.entity_name || '?').padEnd(35)} assn_status=${a.status} entity_status=${e?.status} 8821=${e?.signed_8821_url ? 'YES' : 'no'}`);
  }
}

// Check Jaykumar Patel assignment
const { data: jp } = await sb.from('request_entities')
  .select('id, entity_name, status, signed_8821_url')
  .ilike('entity_name', '%Jaykumar%').limit(2);
console.log(`\nJaykumar entities: ${jp?.length || 0}`);
for (const e of jp || []) {
  const { data: aa } = await sb.from('expert_assignments')
    .select('id, expert_id, status, profiles!expert_assignments_expert_id_fkey(email, full_name)')
    .eq('entity_id', e.id);
  console.log(`  · ${e.entity_name} (${e.status}, 8821=${e.signed_8821_url ? 'Y' : 'n'})`);
  for (const a of aa || []) console.log(`      assn: expert=${a.profiles?.email} (${a.profiles?.full_name}) status=${a.status}`);
}

// SLA snapshot
const oneDayAgo = new Date(Date.now() - 86400_000).toISOString();
const { data: stuckSigned } = await sb.from('request_entities')
  .select('id, entity_name, updated_at')
  .eq('status', '8821_signed')
  .lt('updated_at', oneDayAgo);
console.log(`\n8821_signed > 1 day: ${stuckSigned?.length || 0}`);

const { data: stuckSent } = await sb.from('request_entities')
  .select('id, entity_name, updated_at')
  .eq('status', '8821_sent')
  .lt('updated_at', oneDayAgo);
console.log(`8821_sent > 1 day: ${stuckSent?.length || 0}`);
