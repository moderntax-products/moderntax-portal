import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  // Pull full row for both sessions to get transcripts
  const { data: sessions } = await supabase
    .from('irs_call_sessions' as any)
    .select('*')
    .in('id', ['aa642656-bc92-4710-80e9-0b22bd91b74d', 'eec4a94a-be17-463c-9df0-1d0a56698b91']) as { data: any[] | null };

  for (const s of sessions || []) {
    console.log(`\n=== Session ${s.id} (${s.status}) ===`);
    const tx = s.concatenated_transcript || s.transcript || '';
    console.log(`Transcript (${tx.length} chars):`);
    console.log(tx.slice(0, 3000));
    console.log(tx.length > 3000 ? '\n... [truncated]' : '');
  }

  // Pull irs_call_entities for the cancelled session
  const { data: cancelledEnts } = await supabase
    .from('irs_call_entities' as any)
    .select('*, request_entities(entity_name, request_id, client_id, signed_8821_url, requests(loan_number, client_id, clients(name)))')
    .eq('call_session_id', 'aa642656-bc92-4710-80e9-0b22bd91b74d') as { data: any[] | null };

  console.log('\n\n=== Entities on cancelled call (with 8821 paths + clients) ===');
  for (const ce of cancelledEnts || []) {
    const re = (ce as any).request_entities;
    console.log(`\n  • ${ce.taxpayer_name}`);
    console.log(`    entity_id:     ${ce.entity_id}`);
    console.log(`    form/years:    ${ce.form_type} ${JSON.stringify(ce.tax_years)}`);
    console.log(`    client:        ${re?.requests?.clients?.name || '—'}`);
    console.log(`    loan:          ${re?.requests?.loan_number || '—'}`);
    console.log(`    8821 path:     ${re?.signed_8821_url || '—'}`);
    console.log(`    request_id:    ${re?.request_id || '—'}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
