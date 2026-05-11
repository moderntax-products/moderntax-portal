/**
 * Assign Great Lakes Wood Co LLC to expert matthewaparker@icloud.com
 * for the 2022 + 2025 follow-up pull. Re-uses the existing 8821 (which
 * covers 2022-2026 for 1120/1120S/1065 — verified earlier).
 *
 * Workflow:
 *   1. Check for an existing assignment for this entity. If one exists
 *      and the entity is being re-queued, re-open it (status -> 'assigned')
 *      rather than create a duplicate.
 *   2. Otherwise insert a fresh expert_assignments row.
 *   3. Audit-log the action.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ENTITY_ID  = '86027ead-be1d-447a-86dd-a286bf03bee1';
const REQUEST_ID = '4c697df8-f7f1-4aea-a309-3c4a0026eccd';
const EXPERT_ID  = 'bd374d60-5146-4ca9-90e6-29af28af641f'; // matthewaparker@icloud.com

async function main() {
  // 1. Look at the assignments table schema first — peek at one row to see what columns exist.
  const { data: peek } = await supabase
    .from('expert_assignments')
    .select('*')
    .limit(1);
  console.log('Schema (sample expert_assignments row keys):');
  console.log(Object.keys(peek?.[0] || {}));

  // 2. Find existing assignments for this entity.
  const { data: existing } = await supabase
    .from('expert_assignments')
    .select('id, expert_id, entity_id, status, assigned_at, completed_at')
    .eq('entity_id', ENTITY_ID)
    .order('assigned_at', { ascending: false });

  console.log(`\nExisting assignments for entity ${ENTITY_ID}: ${existing?.length || 0}`);
  for (const a of existing || []) {
    console.log(`  ${a.id}  expert=${a.expert_id}  status=${a.status}  assigned_at=${a.assigned_at}  completed_at=${a.completed_at}`);
  }

  const sameExpert = (existing || []).find((a: any) => a.expert_id === EXPERT_ID);

  let assignmentId: string;

  if (sameExpert && sameExpert.status === 'completed') {
    // Re-open the existing assignment so the SLA clock + history stays continuous.
    console.log(`\n→ Re-opening existing completed assignment ${sameExpert.id}`);
    const { error } = await (supabase
      .from('expert_assignments') as any)
      .update({
        status: 'assigned',
        completed_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', sameExpert.id);
    if (error) { console.error('reopen failed:', error); return; }
    assignmentId = sameExpert.id;
    console.log('✓ re-opened');
  } else if (sameExpert) {
    console.log(`\n→ Existing assignment ${sameExpert.id} is already at status=${sameExpert.status}; nothing to do.`);
    assignmentId = sameExpert.id;
  } else {
    console.log(`\n→ No existing assignment for this expert; creating new`);
    const { data: created, error } = await (supabase
      .from('expert_assignments') as any)
      .insert({
        request_id: REQUEST_ID,
        entity_id: ENTITY_ID,
        expert_id: EXPERT_ID,
        status: 'assigned',
        assigned_at: new Date().toISOString(),
      })
      .select('id')
      .single() as { data: { id: string } | null; error: any };
    if (error || !created) { console.error('insert failed:', error); return; }
    assignmentId = created.id;
    console.log(`✓ created ${assignmentId}`);
  }

  // 3. Audit log
  await (supabase.from('audit_log') as any).insert({
    user_email: 'matt@moderntax.io',
    action: 'expert_assigned',
    entity_type: 'request_entity',
    entity_id: ENTITY_ID,
    request_id: REQUEST_ID,
    details: {
      assignment_id: assignmentId,
      expert_id: EXPERT_ID,
      expert_email: 'matthewaparker@icloud.com',
      reason: 'Soobin Song follow-up — pull 2022 + 2025 for Great Lakes Wood Co LLC (no-charge)',
      years_to_pull: ['2022', '2025'],
      no_charge: true,
    },
  });
  console.log('✓ audit logged\n');
  console.log(`assignment_id = ${assignmentId}`);
}

main().catch(e => { console.error(e); process.exit(1); });
