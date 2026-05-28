import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
for (const fn of ['exec', 'exec_sql', 'execute_sql', 'run_sql']) {
  const { data, error } = await sb.rpc(fn, { sql: 'SELECT 1' });
  console.log(`rpc(${fn}):`, error ? `ERR ${error.message}` : `OK ${JSON.stringify(data)}`);
}
