import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const targets = [
  { slug: 'banc-of-california', allowMore: 1 },
  { slug: 'enterprise-financial-services-corp', allowMore: 3 },
  { slug: 'growth-corp', allowMore: 2 },
];

for (const t of targets) {
  const { data: c } = await sb.from('clients').select('id, name').eq('slug', t.slug).single();
  if (!c) { console.log(`❌ slug=${t.slug} not found`); continue; }
  const { count } = await sb.from('request_entities')
    .select('id, requests!inner(client_id)', { count: 'exact', head: true })
    .eq('requests.client_id', c.id)
    .eq('status', 'completed');
  const completed = count ?? 0;
  const cap = completed + t.allowMore;
  console.log(`${c.name.padEnd(35)} completed=${completed.toString().padStart(2)}  +${t.allowMore} more  →  trial_entities_allowed = ${cap}`);
}
