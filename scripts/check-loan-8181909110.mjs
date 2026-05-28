import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data } = await sb.from('requests')
  .select('id, loan_number, status, cancelled_at, notes, created_at, requested_by, client_id, clients(name)')
  .eq('loan_number', '8181909110');
console.log(`Requests with loan 8181909110: ${data?.length || 0}\n`);
for (const r of data || []) {
  console.log(`Request: ${r.id}`);
  console.log(`  Loan:         ${r.loan_number}`);
  console.log(`  Status:       ${r.status}`);
  console.log(`  Cancelled at: ${r.cancelled_at ?? '(null)'}`);
  console.log(`  Created:      ${r.created_at}`);
  console.log(`  Client:       ${r.clients?.name}`);
  console.log(`  Notes:        ${r.notes ? r.notes.slice(0, 100) : '(none)'}`);
  console.log();
}

// Check column existence by querying schema
const { data: cols, error: colErr } = await sb.rpc('exec_sql', { sql: "SELECT column_name FROM information_schema.columns WHERE table_name='requests'" }).then(r => r, () => ({ data: null, error: 'no exec_sql RPC' }));
console.log(`Schema RPC: ${colErr || 'OK'}`);
if (cols) console.log('Columns:', cols);

// Try a no-op update on cancelled_at to see if it exists
const testId = data?.[0]?.id;
if (testId) {
  const { error: testErr } = await sb.from('requests').update({ cancelled_at: null }).eq('id', testId);
  console.log(`Test update cancelled_at → null: ${testErr ? `FAIL: ${testErr.message}` : 'OK (column exists)'}`);
}

// Also test 'notes' column
if (testId) {
  const { error: notesErr } = await sb.from('requests').update({ notes: null }).eq('id', testId);
  console.log(`Test update notes → null: ${notesErr ? `FAIL: ${notesErr.message}` : 'OK (column exists)'}`);
}

// Also test status='cancelled'
if (testId) {
  const { error: stErr } = await sb.from('requests').update({ status: data[0].status }).eq('id', testId); // no-op
  console.log(`Test update status (no-op): ${stErr ? `FAIL: ${stErr.message}` : 'OK'}`);
}
