/**
 * Katie Lent (Growth Corp) reported 2026-05-15 ~1:55 PM:
 * The 1120 transcripts we delivered for Troch-Mc Neil Paving Co. came
 * back as "no record" because they were pulled under the default 12/31
 * fiscal year end. Katie's submission explicitly noted 2/28 FYE.
 *
 * Two entity rows exist:
 *   18019775-1602-44d5-afae-d92ba5b5eb67  status=completed (the no-record pull)
 *   6381b416-d73e-4ea2-b939-2f1f5b3bd822  status=failed    (the duplicate re-queue)
 *
 * Plan:
 *   1. Set fiscal_year_end_month=2 on BOTH rows so any future pull
 *      uses tax_period YYYY02, not YYYY12.
 *   2. Re-queue 6381b416 (status='failed' → 'irs_queue') so autodial
 *      picks it up Monday morning.
 *   3. Reactivate the iCloud expert assignment if it got marked terminal.
 *   4. Record the correction in gross_receipts._fye_corrections audit log.
 *   5. Leave the completed row alone — Matt can purge the useless
 *      12/31 no-record transcripts separately if he wants.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const COMPLETED_ID = '18019775-1602-44d5-afae-d92ba5b5eb67';
const FAILED_ID    = '6381b416-d73e-4ea2-b939-2f1f5b3bd822';
const ICLOUD_EXPERT_ID = 'bd374d60-5146-4ca9-90e6-29af28af641f';

const auditEntry = {
  prev_fye_month: null,
  new_fye_month: 2,
  reason: 'Katie Lent (Growth Corp VP Closing Mgr) reported 2026-05-15 — Troch-Mc Neil Paving Co. has 2/28 fiscal year end. 12/31 default pull returned "no record" for all 3 years. Re-queueing duplicate row 6381b416 with FYE=2 to pull tax_period YYYY02.',
  corrected_at: new Date().toISOString(),
  corrected_by: 'matt@moderntax.io',
};

for (const id of [COMPLETED_ID, FAILED_ID]) {
  const { data: ent } = await sb.from('request_entities')
    .select('id, entity_name, status, fiscal_year_end_month, gross_receipts').eq('id', id).single();
  if (!ent) { console.log(`Skipping ${id} — not found`); continue; }

  const updatedGr = {
    ...(ent.gross_receipts || {}),
    _fye_corrections: [
      ...((ent.gross_receipts && ent.gross_receipts._fye_corrections) || []),
      auditEntry,
    ],
  };

  const { error } = await sb.from('request_entities')
    .update({ fiscal_year_end_month: 2, gross_receipts: updatedGr })
    .eq('id', id);
  if (error) { console.error(`✗ FYE update failed for ${id}: ${error.message}`); process.exit(1); }
  console.log(`✓ ${ent.entity_name} (${id.slice(0,8)}) FYE: ${ent.fiscal_year_end_month ?? 'null'} → 2 (status=${ent.status})`);
}

// Re-queue the failed row
const { data: failedRow } = await sb.from('request_entities')
  .select('id, status').eq('id', FAILED_ID).single();
if (failedRow.status !== 'irs_queue') {
  const { error } = await sb.from('request_entities')
    .update({ status: 'irs_queue' })
    .eq('id', FAILED_ID);
  if (error) { console.error(`✗ Status flip failed: ${error.message}`); process.exit(1); }
  console.log(`✓ Failed row ${FAILED_ID.slice(0,8)} status: ${failedRow.status} → irs_queue`);
}

// Reactivate iCloud expert assignment on the failed row if any are terminal
const { data: assns } = await sb.from('expert_assignments')
  .select('id, expert_id, status, assigned_at')
  .eq('entity_id', FAILED_ID);
console.log(`\nAssignments on failed row: ${assns?.length || 0}`);
let icloudActive = false;
for (const a of assns || []) {
  const isIcloud = a.expert_id === ICLOUD_EXPERT_ID;
  console.log(`  · expert=${isIcloud ? 'iCloud' : a.expert_id.slice(0,8)} status=${a.status}`);
  if (isIcloud && ['assigned', 'in_progress'].includes(a.status)) icloudActive = true;
}
if (!icloudActive) {
  const icloudRow = (assns || []).find(a => a.expert_id === ICLOUD_EXPERT_ID);
  if (icloudRow) {
    const { error } = await sb.from('expert_assignments')
      .update({ status: 'assigned', assigned_at: new Date().toISOString(), completed_at: null })
      .eq('id', icloudRow.id);
    if (error) { console.error(`⚠ Reactivation failed: ${error.message}`); }
    else console.log(`✓ Reactivated iCloud assignment ${icloudRow.id.slice(0,8)}: ${icloudRow.status} → assigned`);
  } else {
    console.log(`⚠ No iCloud expert assignment on failed row — would need to create one (skipping; requires assigned_by, see fix-grimaldi-assignment).`);
  }
} else {
  console.log(`✓ iCloud expert assignment already active.`);
}

// Verify autodial will pick it up
const { data: openForIcloud } = await sb.from('expert_assignments')
  .select('id, request_entities!inner(id, entity_name, status, fiscal_year_end_month, signed_8821_url)')
  .eq('expert_id', ICLOUD_EXPERT_ID)
  .in('status', ['assigned', 'in_progress'])
  .eq('request_entities.status', 'irs_queue')
  .not('request_entities.signed_8821_url', 'is', null);
console.log(`\nAutodial queue for iCloud expert: ${openForIcloud?.length || 0} entities`);
for (const a of openForIcloud || []) {
  const e = a.request_entities;
  console.log(`  · ${e.entity_name.padEnd(35)} fye=${e.fiscal_year_end_month ?? 'null'}  id=${e.id.slice(0,8)}`);
}
