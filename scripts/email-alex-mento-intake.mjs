/**
 * Email Alex Marcus (Mento CEO) the ERC intake kickoff with intake form +
 * tracking page URLs. Run AFTER seed-mento-erc-reissues.mjs.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const MENTO_ENTITY_ID = 'f92264b1-d420-4865-93f0-33943fc507ff';
const ALEX_EMAIL = 'alex@mento.co';
const ALEX_NAME = 'Alex Marcus';

// Load entity + reissues
const { data: entity, error: entErr } = await sb.from('request_entities')
  .select('entity_name, erc_intake_token')
  .eq('id', MENTO_ENTITY_ID).single();
if (entErr || !entity.erc_intake_token) {
  console.error('✗ Entity or token missing — run seed-mento-erc-reissues.mjs first');
  process.exit(1);
}

const { data: reissues } = await sb.from('erc_check_reissues')
  .select('tax_quarter, original_check_amount, original_check_issued_date')
  .eq('entity_id', MENTO_ENTITY_ID)
  .order('tax_quarter');

const totalRecoverable = (reissues || []).reduce((s, r) => s + Number(r.original_check_amount), 0);
const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io').replace(/^http:\/\/localhost.*/, 'https://portal.moderntax.io');
const intakeUrl = `${appUrl}/erc-reissue/intake/${entity.erc_intake_token}`;
const trackingUrl = `${appUrl}/erc-reissue/${entity.erc_intake_token}`;

console.log(`Sending kickoff email to: ${ALEX_NAME} <${ALEX_EMAIL}>`);
console.log(`  Entity:       ${entity.entity_name}`);
console.log(`  Recoverable:  $${totalRecoverable.toFixed(2)}`);
console.log(`  Intake URL:   ${intakeUrl}`);
console.log(`  Tracking URL: ${trackingUrl}`);
console.log();

const { sendErcIntakeKickoff } = await import('../lib/sendgrid.ts');
await sendErcIntakeKickoff({
  toEmail: ALEX_EMAIL,
  toName: ALEX_NAME,
  entityName: entity.entity_name,
  totalRecoverable,
  intakeUrl,
  trackingUrl,
  quarters: (reissues || []).map(r => ({
    taxQuarter: r.tax_quarter,
    amount: Number(r.original_check_amount),
    issuedDate: r.original_check_issued_date,
  })),
});

console.log('✓ Email sent.');
