import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Check what statuses currently exist (gives us a sense of the constraint)
const { data: statuses } = await sb.from('requests').select('status').limit(500);
const dist = {};
for (const r of statuses || []) dist[r.status] = (dist[r.status] || 0) + 1;
console.log('Current request status distribution:');
for (const [s, c] of Object.entries(dist).sort((a,b)=>b[1]-a[1])) console.log(`  ${s.padEnd(15)} ${c}`);

// Also check entity_status
const { data: entStatuses } = await sb.from('request_entities').select('status').limit(500);
const entDist = {};
for (const r of entStatuses || []) entDist[r.status] = (entDist[r.status] || 0) + 1;
console.log('\nCurrent entity status distribution:');
for (const [s, c] of Object.entries(entDist).sort((a,b)=>b[1]-a[1])) console.log(`  ${s.padEnd(15)} ${c}`);

// And expert_assignments
const { data: asnStatuses } = await sb.from('expert_assignments').select('status').limit(500);
const asnDist = {};
for (const r of asnStatuses || []) asnDist[r.status] = (asnDist[r.status] || 0) + 1;
console.log('\nCurrent assignment status distribution:');
for (const [s, c] of Object.entries(asnDist).sort((a,b)=>b[1]-a[1])) console.log(`  ${s.padEnd(15)} ${c}`);
