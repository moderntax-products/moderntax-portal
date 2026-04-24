import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  // 1. Get all ClearFirm requests
  const { data: client } = await supabase
    .from('clients')
    .select('id, name, domain, webhook_url')
    .eq('slug', 'clearfirm')
    .single();
  
  console.log('=== CLEARFIRM CLIENT ===');
  console.log(JSON.stringify(client, null, 2));

  if (!client) { console.error('No clearfirm client found'); return; }

  // 2. Get all ClearFirm requests with entities
  const { data: requests } = await supabase
    .from('requests')
    .select(`
      id, external_request_token, status, intake_method, created_at, completed_at,
      request_entities(id, entity_name, tid, form_type, years, status, transcript_urls, transcript_html_urls, completed_at)
    `)
    .eq('client_id', client.id)
    .order('created_at', { ascending: true });

  console.log('\n=== CLEARFIRM REQUESTS ===');
  for (const req of (requests || [])) {
    console.log(`\nRequest ${req.external_request_token} (${req.status})`);
    console.log(`  ID: ${req.id}`);
    console.log(`  Created: ${req.created_at}`);
    const entities = (req as any).request_entities || [];
    for (const e of entities) {
      console.log(`  Entity: ${e.entity_name} (${e.form_type}) — ${e.status}`);
      console.log(`    TID: ${e.tid}`);
      console.log(`    transcript_urls: ${JSON.stringify(e.transcript_urls)}`);
      console.log(`    transcript_html_urls: ${JSON.stringify(e.transcript_html_urls)}`);
    }
  }

  // 3. Get webhook deliveries for ClearFirm
  const { data: deliveries } = await supabase
    .from('webhook_deliveries')
    .select('id, request_id, status, payload, created_at, delivered_at, last_status_code, last_error')
    .eq('client_id', client.id)
    .order('created_at', { ascending: true });

  console.log('\n=== WEBHOOK DELIVERIES ===');
  for (const d of (deliveries || [])) {
    const p = d.payload as any;
    console.log(`\nDelivery ${d.id.slice(0,8)} — ${d.status} (HTTP ${d.last_status_code || 'N/A'})`);
    console.log(`  Request: ${d.request_id.slice(0,8)}`);
    console.log(`  Payload status: ${p?.status}`);
    console.log(`  Token: ${p?.request_token}`);
    if (p?.files) console.log(`  Files: ${p.files.length} — types: ${p.files.map((f:any) => f.type).join(', ')}`);
    if (p?.reports) console.log(`  Reports: ${p.reports.length} — types: ${p.reports.map((r:any) => r.type).join(', ')}`);
    console.log(`  Created: ${d.created_at}`);
    console.log(`  Delivered: ${d.delivered_at || 'NOT delivered'}`);
    if (d.last_error) console.log(`  Error: ${d.last_error}`);
  }
}

main().catch(console.error);
