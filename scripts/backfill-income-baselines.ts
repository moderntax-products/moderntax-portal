#!/usr/bin/env node
/**
 * One-shot: walk every completed entity in order of completion date,
 * run captureEntityIncome() on it so the earliest pull becomes the
 * baseline and any subsequent pulls get their snapshot + variance.
 *
 * Required AFTER running the migration-income-baseline.sql migration
 * in Supabase Studio. Idempotent — captureEntityIncome() is safe to
 * re-run because it always pulls the freshest snapshot and only
 * inherits an existing baseline if one is present.
 *
 * Run with:  npx tsx scripts/backfill-income-baselines.ts [--dry-run]
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { captureEntityIncome } from '../lib/income-monitoring-hook';

const DRY = process.argv.includes('--dry-run');
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const env = Object.fromEntries(
  envText.split('\n')
    .filter(l => l && !l.trim().startsWith('#') && l.includes('='))
    .map(l => { const eq = l.indexOf('='); return [l.slice(0, eq).trim(), l.slice(eq + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

async function main() {
  // Pull all completed entities, oldest first — first pull per TID becomes baseline.
  const { data: entities, error } = await sb
    .from('request_entities')
    .select('id, entity_name, tid, form_type, status, completed_at')
    .eq('status', 'completed')
    .in('form_type', ['1120', '1120S', '1120-S', '1065', '1040'])
    .order('completed_at', { ascending: true });
  if (error) { console.error(error); process.exit(1); }
  console.log(`Found ${entities?.length || 0} completed income-bearing entities to process.\n`);

  let baselines = 0, variances = 0, materials = 0, skipped = 0, errors = 0;
  let i = 0;
  for (const e of (entities || [])) {
    i++;
    if (DRY) {
      console.log(`  [${i}] ${e.entity_name}  form=${e.form_type}  tid=${e.tid}  completed=${e.completed_at}`);
      continue;
    }
    try {
      const result = await captureEntityIncome(e.id, sb);
      if (result.skipReason) {
        skipped++;
        console.log(`  ${i}. SKIP  ${e.entity_name}  — ${result.skipReason}`);
      } else if (result.baselineEstablished) {
        baselines++;
        console.log(`  ${i}. BASE  ${e.entity_name}  (${e.tid}) — baseline set: gross=${result.snapshot?.grossReceipts}, totalIncome=${result.snapshot?.totalIncome}`);
      } else if (result.variance) {
        variances++;
        if (result.variance.overallSeverity === 'MATERIAL') {
          materials++;
          console.log(`  ${i}. MATERIAL  ${e.entity_name}  (${e.tid}) — ${result.variance.summary}`);
        } else {
          console.log(`  ${i}. ${result.variance.overallSeverity}  ${e.entity_name}  (${e.tid})`);
        }
      }
    } catch (err: any) {
      errors++;
      console.error(`  ${i}. ERROR ${e.entity_name}: ${err.message}`);
    }
    if (i % 20 === 0) console.log(`\n   ...processed ${i}/${entities!.length}\n`);
  }

  console.log(`\n=== BACKFILL ${DRY ? 'DRY-RUN ' : ''}COMPLETE ===`);
  console.log(`  ${baselines} baselines established`);
  console.log(`  ${variances} variance results (${materials} MATERIAL)`);
  console.log(`  ${skipped} skipped`);
  console.log(`  ${errors} errors`);
  if (materials > 0 && !DRY) {
    console.log(`\n  ⚠ ${materials} MATERIAL variance emails fired to client managers.`);
  }
}
