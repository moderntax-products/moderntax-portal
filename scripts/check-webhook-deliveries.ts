/**
 * Check whether webhook deliveries already fired for the two completed
 * Clearfirm entities, and what state they're in.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const REQUEST_IDS_BY_NAME: Record<string, string> = {};

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const ENTITY_IDS = [
    '04ec6ff0-387b-45d0-8f03-0d01047d6a31',
    '6844fd60-6dfb-4a56-9a8c-c36b97a9b860',
  ];
  const { data: ents } = await supabase
    .from('request_entities')
    .select('id, entity_name, request_id')
    .in('id', ENTITY_IDS) as { data: any[] | null };
  const requestIds = Array.from(new Set((ents || []).map((e: any) => e.request_id)));
  for (const e of ents || []) REQUEST_IDS_BY_NAME[e.entity_name] = e.request_id;
  console.log('Request IDs:', REQUEST_IDS_BY_NAME);

  // Pull webhook_deliveries for these requests
  const { data: deliveries } = await supabase
    .from('webhook_deliveries')
    .select('id, request_id, webhook_url, status, attempts, last_attempt_at, last_response_status, last_error, payload')
    .in('request_id', requestIds)
    .order('created_at', { ascending: true }) as { data: any[] | null };

  console.log(`\n=== webhook_deliveries: ${deliveries?.length || 0} rows ===`);
  for (const d of deliveries || []) {
    console.log(`\n  id:                 ${d.id}`);
    console.log(`  request_id:         ${d.request_id}`);
    console.log(`  status:             ${d.status}`);
    console.log(`  attempts:           ${d.attempts}`);
    console.log(`  last_attempt_at:    ${d.last_attempt_at || '—'}`);
    console.log(`  last_response_status: ${d.last_response_status || '—'}`);
    console.log(`  last_error:         ${d.last_error || '—'}`);
    const p = d.payload || {};
    console.log(`  payload.status:     ${p.status || '—'}`);
    console.log(`  payload.files:      ${(p.files || []).length} files`);
    (p.files || []).slice(0, 5).forEach((f: any) => console.log(`    - ${f.type || '?'} ${f.year || ''} ${f.file_name || ''}`));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
