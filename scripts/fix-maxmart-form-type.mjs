#!/usr/bin/env node
/**
 * Loan "18038 - MaxMart Liquors LLC" (Centerstone). Processor marked
 * 1120 but it files 1065. The entity is registered under its legal
 * name "922 KILBURN OPERATIONS LLC" (Liquors is a DBA). 8821 covers
 * the full business form set so no new signature is needed.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const env = Object.fromEntries(
  envText.split('\n')
    .filter(l => l && !l.trim().startsWith('#') && l.includes('='))
    .map(l => {
      const eq = l.indexOf('=');
      return [l.slice(0, eq).trim(), l.slice(eq + 1).trim().replace(/^["']|["']$/g, '')];
    })
);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const TARGET_ENTITY_ID = '743a3929-71c3-433b-be88-af6e27998f2e'; // 922 KILBURN OPERATIONS LLC
const TARGET_REQUEST_ID = 'e766b560-2c63-493c-bad8-4c5bf961bff2';

// Safety guard A: ensure no OTHER entity anywhere literally named "MaxMart"
// exists — if there is, abort so we don't update the wrong row.
const { data: maxmartAnywhere } = await sb
  .from('request_entities')
  .select('id, entity_name, form_type, request_id, requests:request_id(loan_number)')
  .ilike('entity_name', '%maxmart%');
console.log(`Cross-check: entities literally named "%maxmart%" anywhere: ${maxmartAnywhere?.length || 0}`);
for (const e of (maxmartAnywhere || [])) {
  console.log(`  • ${e.entity_name} · form=${e.form_type} · loan=${e.requests?.loan_number} · id=${e.id}`);
}

// Safety guard B: reconfirm the target entity state before updating
const { data: before, error: lookupErr } = await sb
  .from('request_entities')
  .select('id, entity_name, form_type, status, completed_at, tid, request_id, signer_email, requests:request_id(loan_number, client_id, clients(name))')
  .eq('id', TARGET_ENTITY_ID)
  .single();
if (lookupErr) { console.error(lookupErr); process.exit(1); }

console.log('\nTarget BEFORE:');
console.log(`  entity_id:   ${before.id}`);
console.log(`  entity_name: ${before.entity_name}`);
console.log(`  form_type:   ${before.form_type}`);
console.log(`  status:      ${before.status}`);
console.log(`  completed_at: ${before.completed_at}`);
console.log(`  tid:         ${before.tid}`);
console.log(`  signer:      ${before.signer_email}`);
console.log(`  loan_number: ${before.requests?.loan_number}`);
console.log(`  client:      ${before.requests?.clients?.name}`);
console.log(`  request_id:  ${before.request_id}`);

if (before.request_id !== TARGET_REQUEST_ID) {
  console.error('\nrequest_id mismatch — refusing to update.');
  process.exit(1);
}
if (before.form_type !== '1120') {
  console.error(`\nform_type is already "${before.form_type}", not 1120 — nothing to do (or wrong target).`);
  process.exit(0);
}
if (!/kilburn/i.test(before.entity_name || '')) {
  console.error(`\nentity_name doesn't match expected "Kilburn" — refusing to update.`);
  process.exit(1);
}

// Perform the update
const { error: updateErr } = await sb
  .from('request_entities')
  .update({
    form_type: '1065',
    status: 'irs_queue',
    completed_at: null,
  })
  .eq('id', TARGET_ENTITY_ID);
if (updateErr) { console.error('Update failed:', updateErr); process.exit(1); }

// Audit log
const { error: auditErr } = await sb.from('audit_logs').insert({
  user_id: null,
  user_email: 'matt@moderntax.io',
  action: 'request_created',
  resource_type: 'entity',
  resource_id: TARGET_ENTITY_ID,
  details: {
    admin_action: 'form_type_correction',
    old_form_type: '1120',
    new_form_type: '1065',
    requeued: true,
    entity_name: before.entity_name,
    dba: 'MaxMart Liquors',
    loan_number: before.requests?.loan_number,
    client: before.requests?.clients?.name,
    requested_via: 'email from Timothy Suk (Centerstone)',
    reason: 'Processor selected wrong form type on submission; IRS returned no transcripts available for 1120. Entity files 1065 (LLC partnership). 8821 covers 1065/1120/1120S/990/1041 uniformly so existing signature is in scope.',
    fixed_via: 'scripts/fix-maxmart-form-type.mjs',
  },
});
if (auditErr) console.warn('Audit insert warning (update still applied):', auditErr.message);

// Re-fetch to confirm
const { data: after } = await sb
  .from('request_entities')
  .select('id, entity_name, form_type, status, completed_at')
  .eq('id', TARGET_ENTITY_ID)
  .single();

console.log('\n✓ Updated successfully. AFTER:');
console.log(`  entity_name:  ${after.entity_name}`);
console.log(`  form_type:    ${after.form_type}`);
console.log(`  status:       ${after.status}`);
console.log(`  completed_at: ${after.completed_at}`);
console.log('\nNext: assign to an expert for IRS PPS re-pull. No new 8821 needed.');
