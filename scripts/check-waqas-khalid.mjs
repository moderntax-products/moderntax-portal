import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

console.log(`\n══ Full history for Waqas Khalid · SSN 735-82-9751 ══\n`);

// Try EVERY format variant of the SSN that might be in the DB
const ssnVariants = [
  '735-82-9751',
  '735829751',
  '735 82 9751',
  '735.82.9751',
  '735_82_9751',
];

const { data: tidMatches } = await sb.from('request_entities')
  .select('id, entity_name, tid, tid_kind, form_type, years, status, created_at, updated_at, completed_at, signature_created_at, request_id, requests(loan_number, created_at, clients(name))')
  .in('tid', ssnVariants);

console.log(`Entities with TID exactly matching any SSN variant: ${tidMatches?.length || 0}`);
for (const e of tidMatches || []) {
  console.log(`  · ${e.entity_name.padEnd(20)} tid="${e.tid}" form=${e.form_type} years=${(e.years || []).join(',')}`);
  console.log(`      Entity ID: ${e.id}`);
  console.log(`      Request:   ${e.request_id} (loan ${e.requests?.loan_number}, created ${e.requests?.created_at?.slice(0, 10)})`);
  console.log(`      Status:    ${e.status}`);
  console.log(`      Created:   ${e.created_at?.slice(0, 19)}`);
  console.log(`      Updated:   ${e.updated_at?.slice(0, 19)}`);
  console.log(`      Completed: ${e.completed_at?.slice(0, 19) || '—'}`);
  console.log(`      8821 signed: ${e.signature_created_at?.slice(0, 19) || '—'}`);
  console.log();
}

// Also fuzzy-match the TID in case it has weird whitespace/encoding
const { data: fuzzyTid } = await sb.from('request_entities')
  .select('id, entity_name, tid, form_type, status, created_at, requests(loan_number, clients(name))')
  .or('tid.ilike.%735%9751%,tid.ilike.%735829751%');
console.log(`Fuzzy TID match (anything containing 735...9751): ${fuzzyTid?.length || 0}`);
for (const e of fuzzyTid || []) {
  console.log(`  · ${e.entity_name.padEnd(20)} tid="${e.tid}" created=${e.created_at?.slice(0, 10)} status=${e.status} client=${e.requests?.clients?.name}`);
}

// Match by name including possible misspellings
const { data: byName } = await sb.from('request_entities')
  .select('id, entity_name, tid, form_type, status, created_at, requests(loan_number, clients(name))')
  .or('entity_name.ilike.%waqas%,entity_name.ilike.%khalid%,signer_first_name.ilike.%waqas%,signer_last_name.ilike.%khalid%')
  .order('created_at', { ascending: true });
console.log(`\nAll entities by name (Waqas OR Khalid) in chronological order: ${byName?.length || 0}`);
for (const e of byName || []) {
  console.log(`  · ${e.created_at?.slice(0, 10)}  ${e.entity_name.padEnd(20)} tid="${e.tid}" status=${e.status} loan=${e.requests?.loan_number}`);
}

// Check requests table for loan 18034 history
console.log(`\nFull request history for loan 18034:`);
const { data: loan18034 } = await sb.from('requests')
  .select('id, loan_number, status, created_at, updated_at, completed_at, request_entities(entity_name, tid, status, created_at)')
  .ilike('loan_number', '18034%');
for (const r of loan18034 || []) {
  console.log(`  Request ${r.id} (loan ${r.loan_number}) created ${r.created_at?.slice(0, 19)}`);
  for (const e of r.request_entities || []) {
    console.log(`    · entity ${e.entity_name} (tid ${e.tid}) created ${e.created_at?.slice(0, 19)} status ${e.status}`);
  }
}

// Also check the audit / event log if it exists
const { data: events } = await sb.from('events')
  .select('id, type, created_at, entity_id, payload')
  .or('payload->>entity_name.ilike.%waqas%,payload->>signer_name.ilike.%waqas%')
  .limit(10)
  .order('created_at', { ascending: true });
if (events && events.length) {
  console.log(`\nEvents log mentioning Waqas: ${events.length}`);
  for (const ev of events) console.log(`  · ${ev.created_at?.slice(0, 19)}  ${ev.type}  (entity ${ev.entity_id})`);
}
