import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data } = await supabase
    .from('profiles')
    .select('id, email, full_name, role')
    .in('id', [
      '4a62ae4c-c3c4-4399-87e1-63f4f6851153',
      'bd374d60-5146-4ca9-90e6-29af28af641f',
    ]);
  console.log('USERS:');
  console.log(JSON.stringify(data, null, 2));

  const { data: sample } = await supabase
    .from('entity_monitoring')
    .select('*')
    .limit(1);
  console.log('\nSAMPLE entity_monitoring ROW (all cols):');
  console.log(JSON.stringify(sample?.[0], null, 2));

  // Bucket the 228 active monitoring rows by enrollment source if we can find one
  const { data: monitoring } = await supabase
    .from('entity_monitoring' as any)
    .select('id, entity_id, enrolled_by, enrolled_at, frequency, status, enrollment_source, notes, source')
    .in('status', ['active', 'paused'])
    .limit(500) as { data: any[] | null };

  console.log(`\nTotal active/paused monitoring: ${monitoring?.length}`);
  const byUser: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const m of monitoring || []) {
    byUser[m.enrolled_by || 'NULL'] = (byUser[m.enrolled_by || 'NULL'] || 0) + 1;
    const src = m.enrollment_source || m.source || m.notes?.includes('cron') ? 'cron' : 'unknown';
    bySource[src] = (bySource[src] || 0) + 1;
  }
  console.log('\nBy enrolled_by:');
  console.log(byUser);
  console.log('\nBy source:');
  console.log(bySource);
}
main();
