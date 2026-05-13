#!/usr/bin/env node
/**
 * Comprehensive snapshot of the three active customer threads:
 *   1. Banc of California — request #21402 (Erin Wilsey's first pull)
 *   2. Centerstone / Soobin — 18029 Great Lakes Wood Co LLC (wrong entity pulled?)
 *   3. Centerstone / Timothy — 18038 MaxMart (already fixed; verify state stuck)
 *   4. TaxTaker / Mento Q4 2021 (queued earlier)
 *   5. Migrations status (erc_full_sweep_paid + check_reissue_requests existence)
 *   6. Phone pool / Retell agent versions (env applied?)
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const env = Object.fromEntries(
  envText.split('\n')
    .filter(l => l && !l.trim().startsWith('#') && l.includes('='))
    .map(l => { const eq = l.indexOf('='); return [l.slice(0, eq).trim(), l.slice(eq + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function check(label, fn) {
  console.log('\n═══ ' + label + ' ═══');
  try { await fn(); } catch (e) { console.log('  ERROR:', e.message); }
}

await check('1. Banc of California — request #21402 (Erin Wilsey, first live pull)', async () => {
  const { data: requests } = await sb
    .from('requests')
    .select('id, loan_number, status, created_at, notes, client_id, clients(name)')
    .ilike('loan_number', '%21402%')
    .order('created_at', { ascending: false });
  for (const r of (requests || [])) {
    console.log(`  request_id=${r.id}  loan=${r.loan_number}  client=${r.clients?.name}  status=${r.status}  created=${r.created_at}`);
    const { data: ents } = await sb
      .from('request_entities')
      .select('id, entity_name, form_type, status, signed_8821_url, signature_created_at, completed_at, transcript_html_urls, signer_email')
      .eq('request_id', r.id);
    for (const e of (ents || [])) {
      console.log(`    entity=${e.entity_name}  form=${e.form_type}  status=${e.status}  signer=${e.signer_email}  8821=${e.signed_8821_url ? 'yes' : 'no'}  transcripts=${(e.transcript_html_urls||[]).length}`);
    }
  }
});

await check('2. Centerstone Soobin — 18029 Great Lakes Wood Co LLC', async () => {
  const { data: requests } = await sb
    .from('requests')
    .select('id, loan_number, status, client_id, clients(name)')
    .ilike('loan_number', '%18029%');
  for (const r of (requests || [])) {
    console.log(`  request_id=${r.id}  loan=${r.loan_number}  status=${r.status}`);
    const { data: ents } = await sb
      .from('request_entities')
      .select('id, entity_name, form_type, years, status, completed_at, transcript_html_urls')
      .eq('request_id', r.id);
    for (const e of (ents || [])) {
      console.log(`    entity=${e.entity_name}  form=${e.form_type}  years=${JSON.stringify(e.years)}  status=${e.status}  transcripts=${(e.transcript_html_urls||[]).length}`);
    }
  }
});

await check('3. Centerstone Timothy — 18038 MaxMart (verify fix held)', async () => {
  const { data: ents } = await sb
    .from('request_entities')
    .select('id, entity_name, form_type, status, completed_at')
    .eq('id', '743a3929-71c3-433b-be88-af6e27998f2e')
    .maybeSingle();
  if (!ents) console.log('  entity not found (something wiped it)');
  else console.log(`  ${ents.entity_name}  form=${ents.form_type}  status=${ents.status}  completed_at=${ents.completed_at}`);
});

await check('4. TaxTaker Mento — Q4 2021 queue state', async () => {
  const { data: e } = await sb
    .from('request_entities')
    .select('id, entity_name, form_type, years, status, completed_at')
    .eq('id', 'f92264b1-d420-4865-93f0-33943fc507ff')
    .single();
  console.log(`  ${e.entity_name}  form=${e.form_type}  years=${JSON.stringify(e.years)}  status=${e.status}  completed_at=${e.completed_at}`);
});

await check('5. Migrations status (do columns/tables exist in production?)', async () => {
  const { data, error } = await sb.from('request_entities').select('erc_full_sweep_paid').limit(1);
  console.log(`  request_entities.erc_full_sweep_paid: ${error ? '✗ MISSING (' + error.message + ')' : '✓ exists'}`);

  const { data: c, error: cErr } = await sb.from('check_reissue_requests').select('id').limit(1);
  console.log(`  check_reissue_requests table:          ${cErr ? '✗ MISSING (' + cErr.message + ')' : '✓ exists'}`);

  const { data: aErr } = await sb.from('audit_logs').select('id').limit(1).then(r => ({ data: r.error }));
  console.log(`  audit_logs table:                       ${aErr ? '✗ MISSING (' + aErr.message + ')' : '✓ exists'}`);
});

await check('6. Recent expert assignments + IRS-call sessions (is the queue moving?)', async () => {
  const { data: assn } = await sb
    .from('expert_assignments')
    .select('id, entity_id, expert_id, status, assigned_at, completed_at, request_entities(entity_name, status)')
    .order('assigned_at', { ascending: false })
    .limit(10);
  console.log(`  Last 10 expert assignments:`);
  for (const a of (assn || [])) {
    console.log(`    ${a.assigned_at.slice(0,16)}  ent=${a.request_entities?.entity_name?.slice(0,30).padEnd(30)} assn=${a.status} ent_status=${a.request_entities?.status}`);
  }
});

await check('7. Recent Banc of California account state — is Erin set up?', async () => {
  const { data: cli } = await sb.from('clients').select('id, name, slug, trial_credits_remaining, billing_email').ilike('name', '%banc of cal%');
  for (const c of (cli || [])) {
    console.log(`  client=${c.name}  id=${c.id}  trial_credits=${c.trial_credits_remaining}`);
  }
  const { data: profs } = await sb.from('profiles').select('id, email, role, client_id').ilike('email', '%bancofcal%');
  console.log(`  Profiles:`);
  for (const p of (profs || [])) console.log(`    ${p.email}  role=${p.role}  client_id=${p.client_id}`);
});

await check('8. Enterprise Bank account state — Derek Le logged in but no orders yet', async () => {
  const { data: cli } = await sb.from('clients').select('id, name, trial_credits_remaining').ilike('name', '%enterprise%');
  for (const c of (cli || [])) console.log(`  client=${c.name}  id=${c.id}  trial_credits=${c.trial_credits_remaining}`);
  const { data: profs } = await sb.from('profiles').select('email, role, client_id').ilike('email', '%enterprisebank%');
  for (const p of (profs || [])) console.log(`    ${p.email}  role=${p.role}  client_id=${p.client_id}`);
});
