import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Find the duplicate (status != completed)
const { data: all } = await sb.from('requests')
  .select('id, loan_number, status, cancelled_at, notes')
  .eq('loan_number', '8181909110');
console.log(`All rows with loan 8181909110:`);
for (const r of all || []) console.log(`  · ${r.id} status=${r.status}`);

const dup = (all || []).find(r => r.status !== 'completed');
if (!dup) { console.log('No duplicate to test'); process.exit(0); }
console.log(`\nTarget: ${dup.id} status=${dup.status}\n`);

// Try each field independently to isolate the failure
const tests = [
  { label: "status='cancelled' only",         patch: { status: 'cancelled' } },
  { label: "cancelled_at only",                patch: { cancelled_at: new Date().toISOString() } },
  { label: "notes only",                       patch: { notes: 'test cancel note' } },
];

for (const t of tests) {
  const { error } = await sb.from('requests').update(t.patch).eq('id', dup.id).select('id').single();
  console.log(`${t.label}: ${error ? `FAIL ${error.code || ''} — ${error.message}` : 'OK'}`);
}

// Revert
await sb.from('requests').update({
  status: dup.status,
  cancelled_at: dup.cancelled_at,
  notes: dup.notes,
}).eq('id', dup.id);
console.log('\n✓ Reverted target to original state');
