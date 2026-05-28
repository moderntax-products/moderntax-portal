import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const DUP_ID = 'c752233e-3809-4c22-98c3-c1e9d2d9bcde';
const { data: orig } = await sb.from('requests').select('id, status, cancelled_at, notes').eq('id', DUP_ID).single();
console.log('Original:', JSON.stringify(orig, null, 2));
console.log();

// Test each field independently
const tests = [
  { label: "status='cancelled' only",         patch: { status: 'cancelled' } },
  { label: "cancelled_at only",                patch: { cancelled_at: new Date().toISOString() } },
  { label: "notes only",                       patch: { notes: 'test cancel note' } },
];

for (const t of tests) {
  const { error } = await sb.from('requests').update(t.patch).eq('id', DUP_ID).select('id').single();
  console.log(`${t.label}: ${error ? `FAIL ${error.code || ''} — ${error.message}` : 'OK'}`);
}

// Revert everything
await sb.from('requests').update({
  status: orig.status,
  cancelled_at: orig.cancelled_at,
  notes: orig.notes,
}).eq('id', DUP_ID);
console.log('\n✓ Reverted target to original state');
