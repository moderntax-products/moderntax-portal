/**
 * Check status of OMT Addiction Centers LLC + Blue Peaks Roofing LLC
 * — Clearfirm entities Matt says are now complete. Confirm transcripts
 * are in storage, see current status, and check what's needed to push
 * to Clearfirm's API.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const ENTITY_IDS = [
  '04ec6ff0-387b-45d0-8f03-0d01047d6a31', // OMT Addiction Centers LLC
  '6844fd60-6dfb-4a56-9a8c-c36b97a9b860', // Blue Peaks Roofing LLC
];

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: entities } = await supabase
    .from('request_entities')
    .select(`
      id, entity_name, tid, tid_kind, form_type, years, status,
      transcript_urls, transcript_html_urls, completed_at, updated_at,
      gross_receipts, employment_data, request_id,
      requests(loan_number, external_request_token, status, clients(*))
    `)
    .in('id', ENTITY_IDS) as { data: any[] | null };

  for (const e of entities || []) {
    const r = e.requests;
    const c = r?.clients;
    console.log(`\n=== ${e.entity_name} ===`);
    console.log(`  entity_id:     ${e.id}`);
    console.log(`  status:        ${e.status}`);
    console.log(`  form/years:    ${e.form_type} ${JSON.stringify(e.years)}`);
    console.log(`  completed_at:  ${e.completed_at || '—'}`);
    console.log(`  updated_at:    ${e.updated_at}`);
    console.log(`  transcript_urls (PDF):  ${(e.transcript_urls || []).length}`);
    (e.transcript_urls || []).forEach((u: string) => console.log(`    - ${u}`));
    console.log(`  transcript_html_urls:   ${(e.transcript_html_urls || []).length}`);
    (e.transcript_html_urls || []).forEach((u: string) => console.log(`    - ${u}`));
    console.log(`  request:`);
    console.log(`    loan_number:           ${r?.loan_number}`);
    console.log(`    external_request_token: ${r?.external_request_token || '—'}`);
    console.log(`    status:                ${r?.status}`);
    console.log(`  client (all cols):`);
    console.log(JSON.stringify(c, null, 4));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
