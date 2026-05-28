import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: ents } = await sb.from('request_entities')
  .select('id, entity_name, tid, status, fiscal_year_end_month, gross_receipts, request_id, requests(loan_number, submitter_email, clients(id, name, contact_email, mercury_customer_id))')
  .ilike('entity_name', '%Mento%');

console.log(`Mento entities: ${ents?.length || 0}\n`);
for (const e of ents || []) {
  console.log(`Entity: ${e.entity_name}  id=${e.id}`);
  console.log(`  TID: ${e.tid}  Status: ${e.status}`);
  console.log(`  Loan: ${e.requests?.loan_number}  Submitter: ${e.requests?.submitter_email}`);
  console.log(`  Client: ${e.requests?.clients?.name} <${e.requests?.clients?.contact_email}>`);
  console.log(`  Mercury Customer ID on client: ${e.requests?.clients?.mercury_customer_id || '(none)'}`);
  // ERC findings live in gross_receipts.erc_refund_status typically
  const gr = e.gross_receipts || {};
  if (gr.erc_refund_status) {
    console.log(`  ERC Refund Status:`);
    console.log(`    ${JSON.stringify(gr.erc_refund_status, null, 2).split('\n').join('\n    ')}`);
  }
  if (gr.form_3911_filings) {
    console.log(`  3911 Filings:`);
    console.log(`    ${JSON.stringify(gr.form_3911_filings, null, 2).split('\n').join('\n    ')}`);
  }
  console.log();
}

// Existing invoices on Mento client
const clientId = ents?.[0]?.requests?.clients?.id;
if (clientId) {
  const { data: invoices } = await sb.from('mercury_invoices')
    .select('id, mercury_invoice_number, amount, status, internal_note, created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(10);
  console.log(`Mercury invoices on this client: ${invoices?.length || 0}`);
  for (const i of invoices || []) {
    console.log(`  · ${i.mercury_invoice_number} $${i.amount} ${i.status} created=${i.created_at?.slice(0,10)}`);
    if (i.internal_note) console.log(`      note: ${i.internal_note.slice(0, 100)}`);
  }
}
