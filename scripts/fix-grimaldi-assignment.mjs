/**
 * Finish the Grimaldi reassignment: the previous attempt got the TID
 * fix in but failed on `expert_assignments.assigned_by NOT NULL`.
 *
 * There's already an existing assignment on Grimaldi → iCloud expert
 * with status='failed'. Cleanest path: flip it back to 'assigned'
 * (no new row needed). Also fix the entity status if needed.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const ENTITY_ID = 'aca10f63-e5d3-4673-a3e7-23abff4e3c98';
const ICLOUD_EXPERT_ID = 'bd374d60-5146-4ca9-90e6-29af28af641f';

// 1. Re-load entity + assignments for clarity
const { data: ent } = await sb.from('request_entities')
  .select('id, entity_name, tid, status').eq('id', ENTITY_ID).single();
console.log(`Entity: ${ent.entity_name} (${ent.tid}) status=${ent.status}\n`);

const { data: assns } = await sb.from('expert_assignments')
  .select('id, expert_id, status, assigned_at, completed_at')
  .eq('entity_id', ENTITY_ID)
  .order('assigned_at', { ascending: false });
console.log(`Assignments on this entity (newest first):`);
for (const a of assns || []) {
  console.log(`  · ${a.id}  expert=${a.expert_id === ICLOUD_EXPERT_ID ? 'iCloud' : a.expert_id}  status=${a.status}  assigned=${a.assigned_at?.slice(0,19)}`);
}

// 2. Find the iCloud assignment and reactivate
const icloudAssn = (assns || []).find(a => a.expert_id === ICLOUD_EXPERT_ID);
if (!icloudAssn) {
  console.error('No iCloud assignment exists for this entity — would need to create one with assigned_by set');
  process.exit(1);
}

if (['assigned', 'in_progress'].includes(icloudAssn.status)) {
  console.log(`\n✓ iCloud assignment already active — no change needed.`);
} else {
  const { error } = await sb.from('expert_assignments')
    .update({ status: 'assigned', assigned_at: new Date().toISOString(), completed_at: null })
    .eq('id', icloudAssn.id);
  if (error) { console.error(`✗ Reactivation failed: ${error.message}`); process.exit(1); }
  console.log(`\n✓ Assignment ${icloudAssn.id} reactivated: ${icloudAssn.status} → assigned`);
}

// 3. Make sure entity status is irs_queue so autodial picks it up
if (ent.status !== 'irs_queue') {
  const { error } = await sb.from('request_entities')
    .update({ status: 'irs_queue' })
    .eq('id', ENTITY_ID);
  if (error) { console.error(`⚠ Entity status update failed: ${error.message}`); }
  else console.log(`✓ Entity status: ${ent.status} → irs_queue`);
} else {
  console.log(`✓ Entity already irs_queue.`);
}

// 4. Confirm autodial will pick it up
const { data: openForIcloud } = await sb.from('expert_assignments')
  .select('id, request_entities!inner(entity_name, status, signed_8821_url)')
  .eq('expert_id', ICLOUD_EXPERT_ID)
  .in('status', ['assigned', 'in_progress'])
  .eq('request_entities.status', 'irs_queue')
  .not('request_entities.signed_8821_url', 'is', null);
console.log(`\nOpen assignments for iCloud expert with signed 8821 + irs_queue: ${openForIcloud?.length || 0}`);
for (const a of openForIcloud || []) {
  console.log(`  · ${a.request_entities.entity_name}`);
}
