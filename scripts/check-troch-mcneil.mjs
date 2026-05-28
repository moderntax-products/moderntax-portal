import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data } = await sb.from('request_entities')
  .select('id, entity_name, tid, status, form_type, years, fiscal_year_end_month, created_at, signed_8821_url, gross_receipts, requests(id, loan_number, submitter_email, clients(name))')
  .ilike('entity_name', '%Troch%')
  .order('created_at', { ascending: false });

console.log(`Troch-Mc Neil rows: ${data?.length || 0}\n`);
for (const e of data || []) {
  console.log(`Entity ID: ${e.id}`);
  console.log(`  Name:     ${e.entity_name}`);
  console.log(`  TID:      ${e.tid}`);
  console.log(`  Status:   ${e.status}`);
  console.log(`  Form:     ${e.form_type}`);
  console.log(`  Years:    ${JSON.stringify(e.years)}`);
  console.log(`  FYE month: ${e.fiscal_year_end_month ?? '(null — defaults to 12/31)'}`);
  console.log(`  8821:     ${e.signed_8821_url ? 'signed' : 'NOT signed'}`);
  console.log(`  Created:  ${e.created_at?.slice(0,19)}`);
  console.log(`  Loan:     ${e.requests?.loan_number}  client=${e.requests?.clients?.name} submitter=${e.requests?.submitter_email}`);
  console.log();
}

// Also check transcripts already pulled for these
for (const e of data || []) {
  const { data: tx } = await sb.from('transcripts')
    .select('id, form_type, tax_period, transcript_type, created_at, file_url')
    .eq('entity_id', e.id)
    .order('created_at', { ascending: false });
  console.log(`Transcripts on ${e.entity_name} (${e.id}): ${tx?.length || 0}`);
  for (const t of tx || []) {
    console.log(`  · ${t.form_type} period=${t.tax_period} type=${t.transcript_type} created=${t.created_at?.slice(0,19)}`);
  }
  console.log();
}
