import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: ent } = await sb.from('request_entities')
  .select('*')
  .ilike('entity_name', '%Mento%')
  .single();

console.log(`Entity: ${ent.entity_name}`);
console.log(`  id: ${ent.id}`);
console.log(`  TID: ${ent.tid}`);
console.log(`  Status: ${ent.status}`);
console.log(`  Form: ${ent.form_type}  Years: ${JSON.stringify(ent.years)}`);
console.log(`  Request ID: ${ent.request_id}`);
console.log();

const { data: req } = await sb.from('requests').select('*').eq('id', ent.request_id).single();
console.log(`Request: loan=${req.loan_number} submitter=${req.submitter_email} client_id=${req.client_id}`);

const { data: client } = await sb.from('clients').select('*').eq('id', req.client_id).single();
console.log(`Client: ${client.name} <${client.contact_email}>`);
console.log(`  Mercury customer id: ${client.mercury_customer_id || '(none)'}`);
console.log(`  Billing rate (PDF): ${client.billing_rate_pdf}`);
console.log(`  All client columns:`, Object.keys(client).filter(k => k.includes('mercury') || k.includes('bill') || k.includes('rate') || k.includes('payment')));

// gross_receipts deep look for ERC + 3911
console.log(`\nMento gross_receipts keys:`, Object.keys(ent.gross_receipts || {}));
const gr = ent.gross_receipts || {};
for (const k of Object.keys(gr)) {
  if (k.toLowerCase().includes('erc') || k.includes('3911') || k.includes('refund') || k.includes('check')) {
    console.log(`\n${k}:`);
    console.log(JSON.stringify(gr[k], null, 2).split('\n').slice(0, 40).join('\n'));
  }
}

// Check transcripts for refund signals (TC 846 disbursements)
const { data: tx } = await sb.from('transcripts')
  .select('id, form_type, tax_period, transcript_type, parsed_summary')
  .eq('entity_id', ent.id);
console.log(`\nTranscripts on Mento: ${tx?.length || 0}`);
for (const t of tx || []) {
  console.log(`  · ${t.form_type} ${t.tax_period} ${t.transcript_type}`);
}

// Mercury invoices
const { data: invs } = await sb.from('mercury_invoices')
  .select('id, mercury_invoice_number, amount, status, internal_note, created_at')
  .eq('client_id', client.id)
  .order('created_at', { ascending: false });
console.log(`\nMercury invoices for ${client.name}: ${invs?.length || 0}`);
for (const i of invs || []) console.log(`  · ${i.mercury_invoice_number} $${i.amount} ${i.status}`);
