import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// TaxTaker billing rates + Mercury status
const { data: c } = await sb.from('clients').select('*').eq('slug', 'taxtaker-inc').single();
if (!c) { console.error('TaxTaker not found'); process.exit(1); }
console.log(`TaxTaker billing config:`);
console.log(`  rate_pdf:                 $${c.billing_rate_pdf?.toFixed(2)}`);
console.log(`  rate_csv:                 $${c.billing_rate_csv?.toFixed(2)}`);
console.log(`  rate_monitoring:          $${c.billing_rate_monitoring?.toFixed(2)}`);
console.log(`  free_trial:               ${c.free_trial}`);
console.log(`  trial_entities_allowed:   ${c.trial_entities_allowed}`);
console.log(`  billing_model:            ${c.billing_model}`);
console.log(`  ap_email:                 ${c.billing_ap_email}`);
console.log(`  payment_method:           ${c.billing_payment_method}`);
console.log(`  mercury_customer_id:      ${c.mercury_customer_id || '—'}`);
console.log(`  bypass_payment_paywall:   ${c.bypass_payment_paywall}\n`);

// Most recent requests on TaxTaker (find Ari's new one)
const { data: reqs } = await sb.from('requests')
  .select('id, loan_number, status, intake_method, created_at, completed_at, notes, request_entities(id, entity_name, tid, form_type, years, status, created_at)')
  .eq('client_id', c.id)
  .order('created_at', { ascending: false })
  .limit(5);

console.log(`5 most recent TaxTaker requests:\n`);
for (const r of reqs || []) {
  const ents = r.request_entities || [];
  console.log(`  ${r.created_at?.slice(0,19)}  loan=${r.loan_number}  status=${r.status}  intake=${r.intake_method}  entities=${ents.length}`);
  for (const e of ents) {
    console.log(`     · ${e.entity_name.padEnd(35)} ${e.form_type} years=${(e.years || []).join(',')} tid=${e.tid} status=${e.status}`);
  }
  if (r.notes) console.log(`     notes: ${r.notes.slice(0, 100)}`);
}
