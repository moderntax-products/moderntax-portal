/**
 * Close LaTonya Holmes's stale April 28 assignment on Great Lakes Wood
 * Co LLC. She never started the work (no expert_clock_started_at, no
 * upload, no completion); the entity was re-assigned to Matt today.
 *
 * Note for context: LaTonya is the designee listed on the 8821 itself
 * (PTIN 0316-30210). Her CAF is the one the IRS PPS unit will validate
 * against if we re-call. If she's the right person to make the call,
 * Matt should re-assign back to her after talking with her. For now,
 * close so we don't have two assignments open simultaneously.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const STALE_ASSIGNMENT_ID = 'b640eb74-5323-48c9-884b-6fd111d57c6f';
const ENTITY_ID = '86027ead-be1d-447a-86dd-a286bf03bee1';
const REQUEST_ID = '4c697df8-f7f1-4aea-a309-3c4a0026eccd';

async function main() {
  // Sample the table for valid status values before assuming 'cancelled' works
  const { data: statuses } = await supabase
    .from('expert_assignments')
    .select('status')
    .neq('status', null)
    .limit(200);
  const seen = new Set((statuses || []).map((r: any) => r.status));
  console.log('Distinct status values seen in expert_assignments:', Array.from(seen));

  // Use 'cancelled' if it's already in use; else fall back to 'completed' with miss_reason.
  const useCancelled = seen.has('cancelled');
  const now = new Date().toISOString();
  const update: any = {
    completed_at: now,
    miss_reason: 'reassigned',
    expert_notes: 'Stale assignment closed 2026-05-11 — never started (no clock, no upload). Entity re-assigned to matthewaparker@icloud.com for the Soobin follow-up pull (2022 + 2025 years).',
    updated_at: now,
  };
  if (useCancelled) update.status = 'cancelled';
  else update.status = 'completed';

  console.log(`\nWill update assignment ${STALE_ASSIGNMENT_ID} with status=${update.status}`);

  const { error } = await (supabase
    .from('expert_assignments') as any)
    .update(update)
    .eq('id', STALE_ASSIGNMENT_ID);

  if (error) { console.error('Update failed:', error); return; }
  console.log('✓ closed');

  await (supabase.from('audit_log') as any).insert({
    user_email: 'matt@moderntax.io',
    action: 'expert_assignment_closed',
    entity_type: 'request_entity',
    entity_id: ENTITY_ID,
    request_id: REQUEST_ID,
    details: {
      assignment_id: STALE_ASSIGNMENT_ID,
      previous_status: 'assigned',
      new_status: update.status,
      reason: 'Stale 12-day-overdue assignment never started; entity re-assigned to matthewaparker@icloud.com today',
    },
  });
  console.log('✓ audit logged');
}

main().catch(e => { console.error(e); process.exit(1); });
