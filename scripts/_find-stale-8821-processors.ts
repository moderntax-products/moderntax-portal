import { createClient } from '@supabase/supabase-js';
async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  // Hisham Eskariyat = signer for ihimanagement2149@gmail.com on multiple entities
  // Seung H Lee = signer at shlee3840@gmail.com
  const { data } = await sb.from('request_entities')
    .select(`id, entity_name, status, signer_email, signer_first_name, signer_last_name, signature_id,
             requests!inner(loan_number, requested_by, profiles!requests_requested_by_fkey(full_name, email))`)
    .or('signer_email.ilike.%ihimanagement%,signer_email.ilike.%shlee3840%,entity_name.ilike.%onepro%,entity_name.ilike.%eskariyat%,entity_name.ilike.%seung%')
    .in('status', ['8821_sent', '8821_signed']) as any;

  console.log(`Stale 8821 entities (status=8821_sent or 8821_signed):\n`);
  const byProcessor = new Map<string, any[]>();
  for (const e of (data || [])) {
    const proc = e.requests?.profiles;
    const procKey = proc?.email || '(unassigned)';
    if (!byProcessor.has(procKey)) byProcessor.set(procKey, []);
    byProcessor.get(procKey)!.push({
      entity: e.entity_name,
      status: e.status,
      signer: e.signer_email,
      loan: e.requests?.loan_number,
      signature_id: e.signature_id,
      proc_name: proc?.full_name,
    });
  }
  for (const [procEmail, items] of byProcessor) {
    console.log(`Processor: ${procEmail} (${items[0]?.proc_name})`);
    for (const i of items) {
      console.log(`  · ${i.entity} | loan ${i.loan} | signer ${i.signer} | status ${i.status}`);
    }
    console.log();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
