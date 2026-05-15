/**
 * Seed Mento's two ERC check reissue rows + generate the intake token.
 * Run AFTER applying supabase/migration-erc-check-reissues.sql in the Supabase SQL editor.
 *
 * What this does:
 *   1. Generates a URL-safe token (~32 chars)
 *   2. Sets request_entities.erc_intake_token on the Mento entity
 *   3. Creates 2 erc_check_reissues rows (Q3 2021, Q4 2021)
 *   4. Outputs the intake URL for the email
 *
 * Idempotent: re-running won't duplicate rows (matches on entity_id + tax_quarter).
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const MENTO_ENTITY_ID = 'f92264b1-d420-4865-93f0-33943fc507ff';

// 1. Load entity
const { data: ent, error: entErr } = await sb.from('request_entities')
  .select('id, entity_name, erc_intake_token')
  .eq('id', MENTO_ENTITY_ID)
  .single();
if (entErr) { console.error(`✗ Failed to load entity: ${entErr.message}`); process.exit(1); }
console.log(`✓ Entity: ${ent.entity_name}`);

// 2. Ensure intake token (preserve if already set so the link doesn't change)
let token = ent.erc_intake_token;
if (!token) {
  token = randomBytes(24).toString('base64url');
  const { error: updErr } = await sb.from('request_entities')
    .update({ erc_intake_token: token })
    .eq('id', MENTO_ENTITY_ID);
  if (updErr) { console.error(`✗ Failed to set token: ${updErr.message}`); process.exit(1); }
  console.log(`✓ Generated intake token`);
} else {
  console.log(`✓ Reusing existing intake token`);
}

// 3. Seed the two check reissue rows
const reissues = [
  {
    entity_id: MENTO_ENTITY_ID,
    tax_quarter: '2021-Q3',
    tax_period_end_date: '2021-09-30',
    form_type: '941',
    original_check_amount: 35449.33,
    original_check_issued_date: '2022-08-29',
    original_check_status: 'returned_to_irs',
    filing_status: 'awaiting_intake',
    status_history: [{
      status: 'awaiting_intake',
      changed_at: new Date().toISOString(),
      changed_by: 'system',
      note_internal: 'Engagement created from 2026-05-15 CEO call with Alex Marcus. Invoice MNT-MENTO-ERC-20260515-01 emailed for $1,479 bundle ($479 recovery + $1,000 reissues).',
      note_merchant_visible: 'Welcome! Complete the intake form so we can update your mailing address with the IRS and call to initiate the refund trace Monday morning.',
    }],
  },
  {
    entity_id: MENTO_ENTITY_ID,
    tax_quarter: '2021-Q4',
    tax_period_end_date: '2021-12-31',
    form_type: '941',
    original_check_amount: 32648.80,
    original_check_issued_date: '2022-08-29',
    original_check_status: 'returned_to_irs',
    filing_status: 'awaiting_intake',
    status_history: [{
      status: 'awaiting_intake',
      changed_at: new Date().toISOString(),
      changed_by: 'system',
      note_internal: 'Engagement created from 2026-05-15 CEO call with Alex Marcus.',
      note_merchant_visible: 'Filed together with the Q3 2021 reissue in a single IRS Business & Specialty Tax Line call.',
    }],
  },
];

for (const row of reissues) {
  // Check for existing row matching entity + quarter
  const { data: existing } = await sb.from('erc_check_reissues')
    .select('id, filing_status')
    .eq('entity_id', row.entity_id)
    .eq('tax_quarter', row.tax_quarter)
    .maybeSingle();
  if (existing) {
    console.log(`  · ${row.tax_quarter} reissue already exists (id=${existing.id.slice(0,8)} status=${existing.filing_status}) — skipping insert`);
    continue;
  }
  const { data: ins, error: insErr } = await sb.from('erc_check_reissues')
    .insert(row)
    .select('id')
    .single();
  if (insErr) { console.error(`✗ ${row.tax_quarter} insert failed: ${insErr.message}`); process.exit(1); }
  console.log(`  ✓ ${row.tax_quarter}: $${row.original_check_amount} reissue row created (id=${ins.id.slice(0,8)})`);
}

const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';
const intakeUrl = `${appUrl}/erc-reissue/intake/${token}`;
const trackingUrl = `${appUrl}/erc-reissue/${token}`;

console.log();
console.log('─'.repeat(70));
console.log(`Intake URL (send to Alex):`);
console.log(`  ${intakeUrl}`);
console.log();
console.log(`Tracking URL (Alex can bookmark to see status updates):`);
console.log(`  ${trackingUrl}`);
console.log('─'.repeat(70));
