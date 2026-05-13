#!/usr/bin/env node
/**
 * Queue the Mento Technologies Q4 2021 (period ending 12/31/2021)
 * 941 Account Transcript pull. Ari Salafia (TaxTaker CEO) approved
 * the $79.98 add-on pull on 2026-05-12 to confirm RSB Q4 2021 status
 * before deciding on the Q3 2021 check-reissue spend.
 *
 * Strategy:
 *   - Mento's existing entity (f92264b1-d420-4865-93f0-33943fc507ff)
 *     already has the 8821 + 3 transcripts pulled. Reuse it.
 *   - Set status back to 'irs_queue' and add 2021-Q4 to the years
 *     array so an expert can re-pull this single quarter.
 *   - Append a note explaining the additional pull so the next
 *     expert picking it up knows what's specifically being requested.
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

const ENTITY_ID = 'f92264b1-d420-4865-93f0-33943fc507ff';

// 1) Fetch current state for safety + audit context
const { data: before, error: lookupErr } = await sb
  .from('request_entities')
  .select('id, entity_name, form_type, status, years, completed_at, tid, request_id, requests:request_id(loan_number, client_id, clients(name))')
  .eq('id', ENTITY_ID)
  .single();
if (lookupErr || !before) { console.error('Entity not found:', lookupErr); process.exit(1); }

console.log('Entity BEFORE:');
console.log(`  ${before.entity_name} (${before.requests?.clients?.name})`);
console.log(`  form_type=${before.form_type}, status=${before.status}, years=${JSON.stringify(before.years)}`);
console.log(`  completed_at=${before.completed_at}`);

// 2) Build new years array — preserve existing + add 2021-Q4
const existingYears = Array.isArray(before.years) ? [...before.years] : [];
const targetYear = '2021-Q4';
if (!existingYears.includes(targetYear)) existingYears.push(targetYear);

// 3) Update entity: requeue + add 2021-Q4 + clear completed_at
const update = {
  status: 'irs_queue',
  years: existingYears,
  completed_at: null,
};
const { error: updErr } = await sb
  .from('request_entities')
  .update(update)
  .eq('id', ENTITY_ID);
if (updErr) { console.error('Update failed:', updErr); process.exit(1); }

// 4) Look up the parent request to add a note explaining the re-queue
const { data: req } = await sb
  .from('requests')
  .select('id, notes')
  .eq('id', before.request_id)
  .single();
const noteSuffix = `\n\n[2026-05-12] Mento Q4 2021 add-on pull authorized by Ari Salafia (TaxTaker CEO). $79.98 single-quarter pull, period ending 12/31/2021. RSB-eligible. Reuses existing 8821 on file (TC 960 from 1/31/2025; CAF 0316-30210R). Trial follow-on — bill on completion.`;
const newNotes = (req?.notes || '') + noteSuffix;
await sb.from('requests').update({ notes: newNotes }).eq('id', before.request_id);

// 5) Re-fetch to verify
const { data: after } = await sb
  .from('request_entities')
  .select('id, entity_name, status, years, completed_at')
  .eq('id', ENTITY_ID)
  .single();

console.log('\n✓ Queued. Entity AFTER:');
console.log(`  status=${after.status}`);
console.log(`  years=${JSON.stringify(after.years)}`);
console.log(`  completed_at=${after.completed_at}`);
console.log(`\nNext: expert assignment cron picks this up + calls IRS PPS for period ending 12/31/2021.`);
console.log(`Track: https://portal.moderntax.io/admin/erc-report/${ENTITY_ID}`);
