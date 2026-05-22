/**
 * One-off enrollment script for Justin Kim's 2026-05-22 confirmation.
 *
 * Justin (Centerstone) confirmed by email on 2026-05-22:
 *
 *   > Yes, that would be great.
 *
 * …in response to Matt's offer to enroll three Centerstone entities in
 * recurring monitoring because the IRS returned "no record of return filed"
 * stubs for TY2025 (filed-deadline already passed):
 *
 *   1. Jaykumar Patel    (1040)
 *   2. Jaygopal Inc      (1120S)
 *   3. Honey Hospitality Inc (1120S)
 *
 * The standard auto-enroll cron skips Centerstone because they have
 * `clients.monitoring_default_enabled = false`. The no-record-found
 * override path in the cron will pick these up on its next run, but Justin
 * already said yes — there's no reason to wait 24 hours for the cron tick.
 * This script enrolls them now.
 *
 * Idempotent: `autoEnrollMonitoring()` short-circuits on existing
 * active/paused subscriptions, so re-running is safe.
 *
 * Run:
 *   npx -y dotenv-cli -e .env.local -- npx tsx scripts/enroll-justin-no-record-monitoring.ts
 */

import { createClient } from '@supabase/supabase-js';
import { autoEnrollMonitoring } from '../lib/repeat-entity';
import { shouldAutoEnrollForNoRecord } from '../lib/no-record-monitoring';

const TARGETS = [
  { name: 'Jaykumar Patel',         id: '3b165227-305a-4e74-84f3-408576dbf870' },
  { name: 'Jaygopal Inc',           id: '3be0ec4d-0d0b-4103-b2ad-a80c7aa5382e' },
  { name: 'Honey Hospitality Inc',  id: '73ca4f1f-6e8e-433c-9dbc-9c3110428846' },
];

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  const admin = createClient(url, key);

  for (const t of TARGETS) {
    const { data: ent, error } = await admin
      .from('request_entities')
      .select(`
        id, request_id, entity_name, form_type, years,
        transcript_urls, transcript_html_urls,
        requests!inner(client_id, clients(name, billing_rate_monitoring, monitoring_default_enabled))
      `)
      .eq('id', t.id)
      .single() as { data: any; error: any };

    if (error || !ent) {
      console.error(`[${t.name}] not found:`, error?.message);
      continue;
    }

    const clientName = ent.requests?.clients?.name;
    const optedOut = ent.requests?.clients?.monitoring_default_enabled === false;
    const perPullFee = ent.requests?.clients?.billing_rate_monitoring ?? 25;

    // Sanity-check: does the entity actually have a no-record-found stub
    // for the most-recent year + a passed deadline? Justin's confirmation
    // implies yes for all 3, but we verify so this script doesn't enroll
    // an entity it shouldn't.
    const decision = shouldAutoEnrollForNoRecord({
      form_type: ent.form_type,
      years: ent.years,
      transcript_urls: ent.transcript_urls,
      transcript_html_urls: ent.transcript_html_urls,
    });

    console.log(
      `[${ent.entity_name}] client=${clientName} form=${ent.form_type} ` +
      `years=${JSON.stringify(ent.years)} opted_out=${optedOut} ` +
      `eligibility=${decision.shouldEnroll ? 'YES' : 'NO'} (${decision.reason})`,
    );

    if (!decision.shouldEnroll) {
      console.warn(`  ⚠ Skipping — auto-enroll rule says no. Inspect manually.`);
      continue;
    }

    const enrolled = await autoEnrollMonitoring(
      admin as any,
      ent.id,
      ent.request_id,
      ent.requests.client_id,
      'cron',
      {
        frequency: 'monthly',
        enrollmentFee: 0,
        perPullFee,
        enrollmentType: 'no_record_found_justin_confirmed_2026_05_22',
      },
    );

    if (enrolled) {
      console.log(`  ✓ Enrolled at $${perPullFee}/month (monthly polling for 2025 filing)`);
    } else {
      console.log(`  · Already enrolled (idempotent skip)`);
    }
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
