import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const ICLOUD = 'bd374d60-5146-4ca9-90e6-29af28af641f';
const { data } = await sb.from('expert_assignments')
  .select('id, status, request_entities!inner(id, entity_name, status, signed_8821_url)')
  .eq('expert_id', ICLOUD)
  .in('status', ['assigned', 'in_progress'])
  .eq('request_entities.status', 'irs_queue')
  .not('request_entities.signed_8821_url', 'is', null);
console.log(`Open iCloud assignments still in irs_queue w/ signed 8821: ${data?.length || 0}`);
for (const a of data || []) {
  console.log(`  · ${a.request_entities.entity_name}`);
}
