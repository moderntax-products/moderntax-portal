import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Find the two target entities
const { data: ents } = await sb.from('request_entities')
  .select('id, entity_name, status, completed_at, request_id')
  .or('entity_name.ilike.%KILBURN%,entity_name.ilike.%Mento%,entity_name.ilike.%MaxMart%')
  .limit(20);
console.log('Target entities:');
for (const e of ents || []) {
  console.log(`  · ${e.entity_name.padEnd(40)} status=${e.status} completed=${e.completed_at || '—'}`);
}

// Recent autodial call sessions
const { data: sessions } = await sb.from('irs_call_sessions')
  .select('id, entity_id, from_number, to_number, classified_outcome, callback_initiated_at, callback_connected_at, error_message, retry_reason, created_at')
  .order('created_at', { ascending: false })
  .limit(5);
console.log('\nLast 5 IRS call sessions:');
for (const s of sessions || []) {
  console.log(`  ${s.created_at?.slice(0, 19)}  from=${s.from_number} → outcome=${s.classified_outcome || 'pending'}  cb_init=${s.callback_initiated_at?.slice(0,19) || '—'}  cb_conn=${s.callback_connected_at?.slice(0,19) || '—'}  err=${s.error_message || s.retry_reason || '—'}`);
}
