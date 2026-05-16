import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: experts } = await sb.from('profiles')
  .select('id, email, full_name, role, caf_number, ptin, phone_number, fax_number, address, city, state, zip_code')
  .eq('role', 'expert')
  .order('full_name');

console.log(`Current experts: ${experts?.length || 0}\n`);
for (const e of experts || []) {
  const missing = [];
  if (!e.full_name?.trim())    missing.push('full_name');
  if (!e.caf_number?.trim())   missing.push('caf_number');
  if (!e.ptin?.trim())         missing.push('ptin');
  if (!e.phone_number?.trim()) missing.push('phone_number');
  console.log(`${e.full_name || '(no name)'.padEnd(20)} | ${e.email.padEnd(35)} | creds=${missing.length === 0 ? '✓ complete' : '⚠ missing ' + missing.join(', ')}`);
}
