import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Find by ID slice
const { data: byId } = await sb.from('requests').select('id, loan_number, status, cancelled_at, notes').eq('id', 'c752233e-46f8-477f-8077-bea4c1c9a0e0').single();
console.log('Trying explicit known ID:', byId ? `${byId.id} loan="${byId.loan_number}" status=${byId.status}` : 'NOT FOUND');

// Search broader
const { data: ilike } = await sb.from('requests').select('id, loan_number, status').ilike('loan_number', '%8181909110%');
console.log(`ilike: ${ilike?.length || 0} rows`);
for (const r of ilike || []) console.log(`  · id=${r.id} loan="${r.loan_number}" (len=${r.loan_number?.length}) status=${r.status}`);

// Try with hex-quoted exact match
const { data: ids } = await sb.from('requests').select('id, loan_number').limit(5).order('created_at', { ascending: false });
console.log(`First 5 loan_numbers:`);
for (const r of ids || []) console.log(`  · "${r.loan_number}" (len=${r.loan_number?.length}, codes=${[...(r.loan_number || '')].map(c=>c.charCodeAt(0)).join(',')})`);
