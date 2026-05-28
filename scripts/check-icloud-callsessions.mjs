import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const ICLOUD = 'bd374d60-5146-4ca9-90e6-29af28af641f';
const since = new Date(Date.now() - 1 * 3600_000).toISOString();
const { data: sessions } = await sb.from('irs_call_sessions')
  .select('id, status, from_number, callback_offered, callback_status, callback_window, started_at, ended_at, outcome, transcript_summary, duration_seconds')
  .eq('expert_id', ICLOUD)
  .gte('started_at', since)
  .order('started_at', { ascending: false });

console.log(`iCloud call sessions this past hour: ${sessions?.length || 0}\n`);
for (const s of sessions || []) {
  const dur = s.duration_seconds ? `${s.duration_seconds}s` : 'in-flight';
  console.log(`${s.started_at?.slice(11,19)}  from=${(s.from_number || '?').padEnd(13)}  status=${(s.status || '?').padEnd(20)}  callback=${s.callback_offered ? `OFFERED (${s.callback_status || '?'})` : 'no'}  outcome=${s.outcome || '-'}  dur=${dur}`);
  if (s.transcript_summary) {
    console.log(`  summary: ${s.transcript_summary.slice(0, 200)}`);
  }
}
