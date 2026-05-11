/**
 * Two-part fix triggered by Soobin Song's report on loan 18029:
 *
 *  1. Great Lakes Wood Co LLC — Soobin asked for 2025 but the original
 *     order only listed 2023+2024. The 8821 covers 2022-2026 so no
 *     re-sign needed. Expand the entity's years and reset status so
 *     the expert queue re-picks it up. (Confirmed 8821 explicitly
 *     covers Income/Civil Penalty/1120-1120S-1065 for 2022-2026.)
 *
 *  2. Monitoring auto-enroll bug. The
 *     /api/cron/auto-enroll-monitoring cron filters on
 *     clients.monitoring_default_enabled, but the column defaults to
 *     TRUE (per migration-team-upgrade-toggles.sql), so every client
 *     auto-enrolls unless explicitly opted out. On 2026-05-07 between
 *     04:15-04:16 UTC the cron swept ~218 entities — overwhelmingly
 *     Centerstone, with some California Statewide and Clearfirm rows.
 *     Of those, only 3 actually had a pull completed; the rest were
 *     pure enrollment-fee-only ($19.99 × 218 = $4,358 of phantom
 *     billing exposure across non-rendered services).
 *
 *     Fix has three parts:
 *     (a) Flip monitoring_default_enabled = FALSE for every client
 *         except those that explicitly opted in (Clearfirm and TMC
 *         already at FALSE — leave alone).
 *     (b) Cancel ONLY the May 7 04:15-04:16 cron batch — these are
 *         demonstrably the cron's work (matching enrollment_at window
 *         and pull_history[0].type = 'repeat_entity_auto_enroll'). DO
 *         NOT touch older rows; some may be legitimate.
 *     (c) Back out the $19.99 enrollment_fee on cancelled rows by
 *         setting total_billed = 0 (no pull was rendered).
 *
 * Pass `--dry-run` to print without writing.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const dryRun = process.argv.includes('--dry-run');
console.log(`MODE: ${dryRun ? 'DRY-RUN (no writes)' : 'EXECUTE (writing changes)'}\n`);

const GREAT_LAKES_WOOD_ID = '86027ead-be1d-447a-86dd-a286bf03bee1';
const REQUEST_ID = '4c697df8-f7f1-4aea-a309-3c4a0026eccd';

// Identified via scripts/audit-monitoring.ts — the May 7 cron sweep window.
const CRON_BATCH_START = '2026-05-07T04:15:00Z';
const CRON_BATCH_END   = '2026-05-07T04:17:00Z';

async function fixGreatLakes() {
  console.log('=== 1. Great Lakes Wood Co LLC — expand years + reset status ===\n');

  const { data: current } = await supabase
    .from('request_entities')
    .select('id, entity_name, years, status, completed_at')
    .eq('id', GREAT_LAKES_WOOD_ID)
    .single() as { data: any | null };

  if (!current) { console.log('Entity not found, aborting'); return; }
  console.log(`Current: years=${JSON.stringify(current.years)} status=${current.status} completed_at=${current.completed_at}`);

  const wantYears = ['2022', '2023', '2024', '2025'];
  console.log(`New:     years=${JSON.stringify(wantYears)} status=8821_signed completed_at=null`);

  if (dryRun) { console.log('(skipped — dry run)\n'); return; }

  // Reset completed_at so the request-status calculator sees this as
  // not-yet-complete after we expand the year range.
  const { error: upErr } = await (supabase
    .from('request_entities') as any)
    .update({
      years: wantYears,
      status: '8821_signed',
      completed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', GREAT_LAKES_WOOD_ID);

  if (upErr) { console.error('Update failed:', upErr); return; }

  await (supabase.from('audit_log') as any).insert({
    user_email: 'matt@moderntax.io',
    action: 'entity_years_expanded',
    entity_type: 'request_entity',
    entity_id: GREAT_LAKES_WOOD_ID,
    request_id: REQUEST_ID,
    details: {
      reason: 'Soobin Song email 2026-05-11 — original order omitted 2022 and 2025; 8821 covers 2022-2026 so no re-sign required',
      previous_years: current.years,
      new_years: wantYears,
      previous_status: current.status,
      new_status: '8821_signed',
      no_charge: true,
    },
  });

  console.log('✓ entity updated + audit logged\n');
}

async function flipClientDefaults() {
  console.log('=== 2a. Flip monitoring_default_enabled to FALSE for clients lacking explicit opt-in ===\n');

  const { data: clients } = await supabase
    .from('clients')
    .select('id, name, monitoring_default_enabled')
    .order('name') as { data: any[] | null };

  if (!clients) return;

  console.log('Current state:');
  for (const c of clients) {
    const flag = c.monitoring_default_enabled;
    console.log(`  ${c.name.padEnd(30)} ${flag === true ? 'TRUE  (auto-enroll)' : flag === false ? 'FALSE (opt-in only)' : 'NULL'}`);
  }

  const toFlip = clients.filter(c => c.monitoring_default_enabled !== false);
  console.log(`\n→ Flipping ${toFlip.length} client(s) to FALSE`);

  if (dryRun) { console.log('(skipped — dry run)\n'); return; }

  const { error } = await (supabase
    .from('clients') as any)
    .update({ monitoring_default_enabled: false })
    .in('id', toFlip.map(c => c.id));

  if (error) { console.error('flip failed:', error); return; }
  console.log('✓ flipped\n');
}

async function cancelCronSweep() {
  console.log('=== 2b. Cancel the May 7 04:15-04:16 UTC cron sweep ===\n');

  const { data: rows } = await supabase
    .from('entity_monitoring' as any)
    .select('id, entity_id, client_id, enrolled_at, status, total_billed, total_pulls_completed, pull_history')
    .in('status', ['active', 'paused'])
    .gte('enrolled_at', CRON_BATCH_START)
    .lte('enrolled_at', CRON_BATCH_END) as { data: any[] | null };

  if (!rows || rows.length === 0) {
    console.log('No matching rows in cron-sweep window\n');
    return;
  }

  // Sanity check: only include rows whose pull_history[0].type marks the
  // auto-flow. Defensive — single-source-of-truth criterion.
  const target = rows.filter(r =>
    r.pull_history?.[0]?.type === 'repeat_entity_auto_enroll' &&
    (r.total_pulls_completed || 0) === 0,        // no service rendered
  );
  console.log(`Cron-sweep candidates: ${rows.length} (of which ${target.length} have 0 pulls completed → safe to cancel)`);

  if (target.length < rows.length) {
    const skipped = rows.filter(r => !target.includes(r));
    console.log(`Skipping ${skipped.length} that have rendered pulls — those will need manual review.`);
    skipped.forEach(s => console.log(`  - ${s.id}: ${s.total_pulls_completed} pulls completed`));
  }

  const totalRefund = target.reduce((s, r) => s + (r.total_billed || 0), 0);
  console.log(`\n→ Would cancel ${target.length} rows and back out $${totalRefund.toFixed(2)} of enrollment fees`);

  if (dryRun) { console.log('(skipped — dry run)\n'); return; }

  const now = new Date().toISOString();
  const { error } = await (supabase
    .from('entity_monitoring' as any) as any)
    .update({
      status: 'cancelled',
      cancelled_at: now,
      total_billed: 0,                            // back out the $19.99 fee
      // No "cancellation_reason" column on this table — record context
      // in pull_history instead so the audit trail is preserved.
    })
    .in('id', target.map(t => t.id));

  if (error) { console.error('cancel sweep failed:', error); return; }

  // Append a cancellation note to each row's pull_history. Run as a
  // batch via RPC would be ideal but is overkill; iterate.
  for (const t of target) {
    const newHistory = [...(t.pull_history || []), {
      date: now,
      type: 'admin_cancellation_unauthorized_auto_enroll',
      status: 'cancelled',
      reason: 'Auto-cancelled — May 7 cron sweep unauthorized. Soobin Song (Centerstone) flagged; client default flipped to opt-in only.',
    }];
    await (supabase.from('entity_monitoring' as any) as any)
      .update({ pull_history: newHistory })
      .eq('id', t.id);
  }

  console.log(`✓ cancelled ${target.length} rows, backed out $${totalRefund.toFixed(2)} in enrollment fees\n`);
}

async function main() {
  await fixGreatLakes();
  await flipClientDefaults();
  await cancelCronSweep();
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
