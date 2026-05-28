import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const DUP_ID = 'c752233e-...-...';
// Find the full UUID
const { data: full } = await sb.from('requests').select('id, status, cancelled_at, notes').eq('loan_number', '8181909110').neq('status', 'completed').single();
console.log('Target row:', full);
console.log();

// Simulate the exact update the API does
const cancelNote = `Cancelled by matt@moderntax.io on ${new Date().toISOString()} — reason: duplicate request (test)`;
const { data: testUpd, error: updErr } = await sb.from('requests')
  .update({
    status: 'cancelled',
    cancelled_at: new Date().toISOString(),
    notes: full.notes ? `${full.notes}\n\n${cancelNote}` : cancelNote,
  })
  .eq('id', full.id)
  .select('id, status, cancelled_at, notes')
  .single();
console.log('UPDATE result:', updErr ? `FAIL: ${updErr.message} (code=${updErr.code})` : 'OK');
if (testUpd) console.log('  After:', JSON.stringify(testUpd, null, 2));

// REVERT immediately so we don't leave the request cancelled
if (testUpd && !updErr) {
  await sb.from('requests').update({
    status: full.status,
    cancelled_at: full.cancelled_at,
    notes: full.notes,
  }).eq('id', full.id);
  console.log('  Reverted to original state.');
}
