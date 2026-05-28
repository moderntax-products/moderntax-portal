import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const ICLOUD = 'bd374d60-5146-4ca9-90e6-29af28af641f';
const { data: assn } = await sb.from('expert_assignments')
  .select('id, status, request_entities!inner(id, entity_name, status, signed_8821_url, tid)')
  .eq('expert_id', ICLOUD)
  .in('status', ['assigned', 'in_progress'])
  .eq('request_entities.status', 'irs_queue')
  .not('request_entities.signed_8821_url', 'is', null);
console.log(`iCloud expert IRS queue: ${assn?.length || 0} entities ready for PPS call\n`);
for (const a of assn || []) {
  console.log(`  · ${a.request_entities.entity_name.padEnd(35)} TID=${a.request_entities.tid}`);
}

// Recent call sessions
const since = new Date(Date.now() - 4 * 3600_000).toISOString();
const { data: sessions } = await sb.from('irs_call_sessions')
  .select('id, status, from_number, callback_offered, callback_window, started_at, ended_at, outcome, transcript_summary')
  .eq('expert_id', ICLOUD)
  .gte('started_at', since)
  .order('started_at', { ascending: false })
  .limit(20);
console.log(`\nRecent iCloud calls (last 4h): ${sessions?.length || 0}`);
for (const s of sessions || []) {
  console.log(`  · ${s.started_at?.slice(11,16)} from=${s.from_number || '?'} status=${s.status} callback=${s.callback_offered ? 'YES ' + (s.callback_window || '') : 'no'} outcome=${s.outcome || '-'}`);
}
