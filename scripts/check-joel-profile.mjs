import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: joel } = await sb.from('profiles')
  .select('id, email, full_name, role, caf_number, ptin, phone_number, fax_number, address, city, state, zip_code, irs_credentials_updated_at, irs_credentials_consented_at, irs_credentials_used_count, onboarding_completed_at')
  .eq('email', 'joelsteven@earthlink.net')
  .single();

console.log('Joel Abernathy profile:');
console.log(JSON.stringify(joel, null, 2));

console.log('\nDesignee creds (for 8821 PDF):');
console.log(`  CAF #:        ${joel?.caf_number || '(NOT SET)'}`);
console.log(`  PTIN:         ${joel?.ptin || '(NOT SET)'}`);
console.log(`  Phone:        ${joel?.phone_number || '(NOT SET)'}`);
console.log(`  Address:      ${joel?.address || '(NOT SET)'}`);
console.log(`  City/State:   ${joel?.city || '(NOT SET)'}, ${joel?.state || '(NOT SET)'} ${joel?.zip_code || ''}`);

console.log('\nIRS PPS auth creds (for SSN+DOB verify on calls):');
console.log(`  SSN encrypted:  ${joel?.ssn_encrypted ? 'STORED' : '(NOT SET)'}`);
console.log(`  DOB encrypted:  ${joel?.dob_encrypted ? 'STORED' : '(NOT SET)'}`);
console.log(`  Creds set at:   ${joel?.irs_credentials_updated_at || '(NEVER)'}`);
console.log(`  Consented at:   ${joel?.irs_credentials_consented_at || '(NEVER)'}`);
console.log(`  Used count:     ${joel?.irs_credentials_used_count ?? 0}`);
console.log(`  Onboarded at:   ${joel?.onboarding_completed_at || '(NEVER)'}`);

// Did Joel log in?
const { data: audit } = await sb.from('audit_log')
  .select('action, created_at, details')
  .eq('user_email', 'joelsteven@earthlink.net')
  .order('created_at', { ascending: false })
  .limit(10);
console.log(`\nJoel's recent audit log activity (last 10):`);
for (const a of audit || []) {
  console.log(`  · ${a.created_at?.slice(0,16)} | ${a.action}`);
}
console.log(audit?.length === 0 ? '  (no audit log entries — never logged in)' : '');
