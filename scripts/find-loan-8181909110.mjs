import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Try variations
for (const q of ['8181909110', '81-81909110', '8181-90-9110', '818-190-9110']) {
  const { data } = await sb.from('requests').select('id, loan_number, status').or(`loan_number.eq.${q},loan_number.ilike.%${q}%`);
  console.log(`loan_number variations of "${q}": ${data?.length || 0}`);
  for (const r of (data || []).slice(0,3)) console.log(`  · loan=${r.loan_number} status=${r.status} id=${r.id.slice(0,8)}`);
}

// Maybe it's an EIN/SSN
const { data: byTid } = await sb.from('request_entities').select('id, entity_name, tid, status, request_id, requests(loan_number, status)').or('tid.eq.8181909110,tid.eq.81-8190911,tid.eq.818-19-0911,tid.eq.818-19-09110');
console.log(`\nEntities by TID variants: ${byTid?.length || 0}`);
for (const e of byTid || []) {
  console.log(`  · ${e.entity_name} tid=${e.tid} entity_status=${e.status} loan=${e.requests?.loan_number} req_status=${e.requests?.status}`);
}

// Last resort: recent requests with status not in cancellable set + look for duplicates
const since = new Date(Date.now() - 7 * 86400_000).toISOString();
const { data: recent } = await sb.from('requests')
  .select('id, loan_number, status, created_at, requested_by, clients(name)')
  .gte('created_at', since)
  .order('created_at', { ascending: false })
  .limit(40);
console.log(`\nLast 7d requests:`);
for (const r of recent || []) {
  console.log(`  ${(r.loan_number || '?').padEnd(12)} status=${(r.status||'').padEnd(15)} client=${r.clients?.name?.slice(0,25)} created=${r.created_at?.slice(0,16)} id=${r.id.slice(0,8)}`);
}
