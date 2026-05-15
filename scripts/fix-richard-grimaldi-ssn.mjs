/**
 * Robin Kim (Centerstone underwriter) reported 2026-05-14 10:48 PT:
 * Richard C Grimaldi's SSN was entered with the wrong first 3 digits —
 * should be 020 not 025. Name and address are correct.
 *
 * Plus: reassign the entity to expert matthewaparker@icloud.com
 * (profile id bd374d60-5146-4ca9-90e6-29af28af641f) so it goes into
 * his IRS PPS queue alongside the other Centerstone work.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const ICLOUD_EXPERT_ID = 'bd374d60-5146-4ca9-90e6-29af28af641f';

// 1. Find the Grimaldi entity (Centerstone, loan 18044 per earlier query)
const { data: ents } = await sb.from('request_entities')
  .select('id, entity_name, tid, tid_kind, form_type, years, status, gross_receipts, request_id, requests(loan_number, client_id, clients(name))')
  .ilike('entity_name', '%Grimaldi%');

console.log(`Matches: ${ents?.length || 0}\n`);
for (const e of ents || []) {
  console.log(`  · ${e.entity_name.padEnd(28)} tid="${e.tid}" client="${e.requests?.clients?.name}" loan=${e.requests?.loan_number}`);
}

if (!ents || ents.length === 0) {
  console.error('No Grimaldi entity found');
  process.exit(1);
}
if (ents.length > 1) {
  console.error('Multiple matches — pass --id <entity_id> to disambiguate');
  process.exit(1);
}

const target = ents[0];
const oldTid = target.tid;

// 2. Compute corrected SSN. Robin says first 3 digits should be 020, not 025.
// Replace the first 3-digit group with "020".
const ssnMatch = oldTid.match(/^(\d{3})([-\s]?)(\d{2})\2(\d{4})$/) ||
                 oldTid.match(/^(\d{3})(\d{2})(\d{4})$/);
if (!ssnMatch) {
  console.error(`Unexpected TID format: "${oldTid}". Bail.`);
  process.exit(1);
}
// Reconstruct in same format as original (dashed or plain)
let newTid;
if (oldTid.includes('-')) {
  newTid = `020-${ssnMatch[3] || ssnMatch[2]}-${ssnMatch[4] || ssnMatch[3]}`;
} else if (oldTid.includes(' ')) {
  newTid = `020 ${ssnMatch[3] || ssnMatch[2]} ${ssnMatch[4] || ssnMatch[3]}`;
} else {
  newTid = `020${ssnMatch[3] || ssnMatch[2]}${ssnMatch[4] || ssnMatch[3]}`;
}

console.log(`\nApplying SSN correction:`);
console.log(`  TID:  "${oldTid}"  →  "${newTid}"`);

const auditEntry = {
  prev_tid: oldTid,
  new_tid: newTid,
  reason: 'Robin Kim (Centerstone Credit Underwriter) self-reported 2026-05-14 — first 3 digits of SSN were entered as 025 but should be 020. Name and address verified correct.',
  corrected_at: new Date().toISOString(),
};
const updatedGr = {
  ...(target.gross_receipts || {}),
  _tid_corrections: [
    ...((target.gross_receipts && target.gross_receipts._tid_corrections) || []),
    auditEntry,
  ],
};

const { error: upErr } = await sb.from('request_entities')
  .update({ tid: newTid, gross_receipts: updatedGr })
  .eq('id', target.id);
if (upErr) { console.error(`✗ TID update failed: ${upErr.message}`); process.exit(1); }
console.log(`✓ Entity ${target.id} TID updated.`);

// 3. Look up existing assignments for this entity
const { data: existingAssn } = await sb.from('expert_assignments')
  .select('id, expert_id, status, assigned_at, profiles!expert_assignments_expert_id_fkey(email, full_name)')
  .eq('entity_id', target.id);

console.log(`\nExisting assignments on this entity: ${existingAssn?.length || 0}`);
for (const a of existingAssn || []) {
  console.log(`  · expert=${a.profiles?.email || '?'} (${a.profiles?.full_name || '?'}) status=${a.status} assigned=${a.assigned_at?.slice(0, 19)}`);
}

// 4. Check if matthewaparker@icloud.com already has an active assignment
const alreadyAssignedToIcloud = (existingAssn || []).some(a =>
  a.expert_id === ICLOUD_EXPERT_ID && ['assigned', 'in_progress'].includes(a.status)
);

if (alreadyAssignedToIcloud) {
  console.log(`\n✓ Entity already assigned to matthewaparker@icloud.com — no reassignment needed.`);
} else {
  // Mark any existing non-terminal assignments as 'reassigned' (audit) before
  // creating the new one. Use the same 'cancelled' status the existing
  // workflow uses for closed-out assignments.
  for (const a of existingAssn || []) {
    if (['assigned', 'in_progress'].includes(a.status)) {
      await sb.from('expert_assignments').update({ status: 'cancelled' }).eq('id', a.id);
      console.log(`  · Closed prior assignment ${a.id} (was: ${a.status})`);
    }
  }

  // Create the new assignment to iCloud expert
  const { error: assnErr, data: newAssn } = await sb.from('expert_assignments').insert({
    entity_id: target.id,
    expert_id: ICLOUD_EXPERT_ID,
    status: 'assigned',
    assigned_at: new Date().toISOString(),
  }).select('id').single();
  if (assnErr) { console.error(`✗ Assignment create failed: ${assnErr.message}`); process.exit(1); }
  console.log(`\n✓ New assignment ${newAssn.id} → matthewaparker@icloud.com (status=assigned)`);
}

// Also make sure entity status is irs_queue so the autodial script picks it up
if (target.status !== 'irs_queue') {
  const allowedTransition = ['8821_signed', 'processing'].includes(target.status);
  if (allowedTransition) {
    await sb.from('request_entities').update({ status: 'irs_queue' }).eq('id', target.id);
    console.log(`✓ Entity status: ${target.status} → irs_queue (so autodial picks it up)`);
  } else {
    console.log(`⚠ Entity status is "${target.status}" — not auto-transitioning to irs_queue. Set manually if expected.`);
  }
} else {
  console.log(`✓ Entity already irs_queue — autodial will pick it up.`);
}
