/**
 * Audit which monitoring rows came from the cron vs. manual UI/API.
 * Bucket by enrolled_at minute + pull_history[0].type so we can see
 * which records are safe to bulk-cancel.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Pull every active/paused monitoring row
  const { data: monitoring } = await supabase
    .from('entity_monitoring' as any)
    .select('id, entity_id, client_id, enrolled_by, enrolled_at, pull_history, status, total_billed, total_pulls_completed')
    .in('status', ['active', 'paused'])
    .order('enrolled_at', { ascending: true })
    .limit(2000) as { data: any[] | null };

  if (!monitoring) { console.log('No data'); return; }
  console.log(`Total active+paused: ${monitoring.length}`);

  // Bucket by enrolled_at MINUTE + pull_history[0].type so cron sweeps cluster
  const byMinute: Record<string, { count: number; types: Set<string>; sample_client_id?: string }> = {};
  for (const m of monitoring) {
    const t = (m.enrolled_at || '').slice(0, 16); // YYYY-MM-DDTHH:MM
    const type = m.pull_history?.[0]?.type || '?';
    if (!byMinute[t]) byMinute[t] = { count: 0, types: new Set(), sample_client_id: m.client_id };
    byMinute[t].count += 1;
    byMinute[t].types.add(type);
  }
  const sorted = Object.entries(byMinute)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 25);
  console.log('\nTop 25 enrollment minutes by volume (likely cron sweeps):');
  for (const [t, info] of sorted) {
    console.log(`  ${t}  ${String(info.count).padStart(4)} rows  types=${Array.from(info.types).join(',')}`);
  }

  // Pull_history type histogram
  const types: Record<string, number> = {};
  for (const m of monitoring) {
    const t = m.pull_history?.[0]?.type || 'NULL';
    types[t] = (types[t] || 0) + 1;
  }
  console.log('\npull_history[0].type histogram:');
  console.log(types);

  // Total $$ exposure
  const total = monitoring.reduce((s, m) => s + (m.total_billed || 0), 0);
  const totalPulls = monitoring.reduce((s, m) => s + (m.total_pulls_completed || 0), 0);
  console.log(`\nTotal billed across active rows: $${total.toFixed(2)}`);
  console.log(`Total pulls completed: ${totalPulls}`);

  // Count by client
  const byClient: Record<string, number> = {};
  for (const m of monitoring) byClient[m.client_id || 'NULL'] = (byClient[m.client_id || 'NULL'] || 0) + 1;
  // Resolve client names
  const cids = Object.keys(byClient);
  const { data: clients } = await supabase.from('clients').select('id, name').in('id', cids);
  console.log('\nBy client:');
  for (const c of clients || []) {
    console.log(`  ${c.name.padEnd(30)} ${byClient[c.id]} rows`);
  }
}
main();
