import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Try multiple spellings
for (const q of ['%Mento%', '%mento%', '%MENTO%']) {
  const { data } = await sb.from('request_entities').select('id, entity_name, status').ilike('entity_name', q);
  console.log(`request_entities ilike "${q}": ${data?.length || 0}`);
  for (const e of (data || []).slice(0, 3)) console.log(`  · "${e.entity_name}" status=${e.status}`);
}

// Clients
const { data: clients } = await sb.from('clients').select('id, name, contact_email').or('name.ilike.%mento%,contact_email.ilike.%mento%');
console.log(`\nClients ilike mento: ${clients?.length || 0}`);
for (const c of clients || []) console.log(`  · ${c.name} <${c.contact_email}> id=${c.id}`);

// Recently completed entities with ERC findings
const { data: ercEnts } = await sb.from('request_entities')
  .select('id, entity_name, status, gross_receipts, requests(clients(name, contact_email))')
  .eq('status', 'completed')
  .not('gross_receipts', 'is', null)
  .order('updated_at', { ascending: false })
  .limit(20);
console.log(`\nRecent completed entities (looking for ERC findings):`);
for (const e of ercEnts || []) {
  const gr = e.gross_receipts || {};
  const hasErc = gr.erc_refund_status || gr.form_3911_filings || gr.erc_findings;
  if (hasErc) {
    console.log(`  · ${e.entity_name} client=${e.requests?.clients?.name}`);
    console.log(`    keys: ${Object.keys(gr).filter(k => k.toLowerCase().includes('erc') || k.includes('3911') || k.includes('refund')).join(', ')}`);
  }
}
