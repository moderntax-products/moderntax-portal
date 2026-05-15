/**
 * Ari Salafia (TaxTaker) reported 2026-05-15: she entered the CAF number
 * instead of the EIN for "Alternative Finance" on the entity submission.
 * Correct EIN: 87-2213645. The signed 8821 (now re-uploaded with the
 * correct info) is on file.
 *
 * This script:
 *   1. Finds the Alternative Finance entity under TaxTaker
 *   2. Shows the current bad TID + other fields
 *   3. Updates tid to '87-2213645' and tid_kind to 'EIN'
 *   4. Logs the change in audit history (writes to gross_receipts._tid_corrections)
 *      so we have a trail
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Find TaxTaker client
const { data: taxtaker } = await sb.from('clients').select('id').eq('slug', 'taxtaker-inc').single();
if (!taxtaker) { console.error('TaxTaker client not found'); process.exit(1); }

// Find Alternative Finance entity(ies) for TaxTaker
const { data: reqs } = await sb.from('requests').select('id').eq('client_id', taxtaker.id);
const reqIds = (reqs || []).map(r => r.id);

const { data: ents } = await sb.from('request_entities')
  .select('id, entity_name, tid, tid_kind, form_type, years, status, signer_first_name, signer_last_name, signed_8821_url, gross_receipts, created_at, request_id, requests(loan_number)')
  .in('request_id', reqIds.length ? reqIds : ['__none__'])
  .ilike('entity_name', '%Alternative Finance%');

console.log(`\nMatches under TaxTaker for "Alternative Finance": ${ents?.length || 0}\n`);
for (const e of ents || []) {
  console.log(`Entity:        ${e.entity_name}`);
  console.log(`  ID:          ${e.id}`);
  console.log(`  Current TID: "${e.tid}" (${e.tid_kind})    ← Ari said this is the CAF, not the EIN`);
  console.log(`  Form/Years:  ${e.form_type} / ${(e.years || []).join(', ')}`);
  console.log(`  Status:      ${e.status}`);
  console.log(`  Signer:      ${e.signer_first_name || ''} ${e.signer_last_name || ''}`.trim());
  console.log(`  8821 URL:    ${e.signed_8821_url || '—'}`);
  console.log(`  Loan #:      ${e.requests?.loan_number || '—'}`);
  console.log(`  Created:     ${e.created_at?.slice(0, 19)}`);
  console.log();
}

if (!ents || ents.length === 0) {
  console.log('No Alternative Finance entity found. Search wider:');
  // Try without TaxTaker filter, search by signer or by partial name
  const { data: wide } = await sb.from('request_entities')
    .select('id, entity_name, tid, request_id, requests(client_id, clients(name))')
    .or('entity_name.ilike.%Alternative Finance%,entity_name.ilike.%Alt Finance%')
    .limit(5);
  for (const w of wide || []) {
    console.log(`  · ${w.entity_name.padEnd(35)} tid="${w.tid}" client=${w.requests?.clients?.name}`);
  }
  process.exit(0);
}

if (ents.length > 1) {
  console.log(`Multiple matches found — refusing to auto-update. Pick one and rerun with --id <entity_id>.`);
  process.exit(1);
}

const target = ents[0];
const oldTid = target.tid;
const newTid = '87-2213645';
const newTidKind = 'EIN';

if (oldTid === newTid && target.tid_kind === newTidKind) {
  console.log(`Entity already has TID=${newTid} (${newTidKind}). Nothing to update.`);
  process.exit(0);
}

console.log(`Applying update:`);
console.log(`  TID:      "${oldTid}" (${target.tid_kind})  →  "${newTid}" (${newTidKind})`);

// Audit trail: stash the correction in gross_receipts JSONB
const auditEntry = {
  prev_tid: oldTid,
  prev_tid_kind: target.tid_kind,
  new_tid: newTid,
  new_tid_kind: newTidKind,
  reason: 'Ari Salafia (TaxTaker) self-reported entry error — entered CAF number instead of EIN. Corrected EIN per 2026-05-15 08:37 PT email + re-uploaded 8821.',
  corrected_at: new Date().toISOString(),
};
const updatedGr = {
  ...(target.gross_receipts || {}),
  _tid_corrections: [
    ...((target.gross_receipts && target.gross_receipts._tid_corrections) || []),
    auditEntry,
  ],
};

const { error } = await sb.from('request_entities')
  .update({
    tid: newTid,
    tid_kind: newTidKind,
    gross_receipts: updatedGr,
  })
  .eq('id', target.id);

if (error) {
  console.error(`✗ Update failed: ${error.message}`);
  process.exit(1);
}

console.log(`\n✓ Entity ${target.id} updated. TID is now "${newTid}" (${newTidKind}).`);
console.log(`✓ Audit trail stamped into gross_receipts._tid_corrections.`);
