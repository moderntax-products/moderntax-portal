/**
 * One-off: advance Mento engagement to "intake_complete" stage and
 * capture Alex's new mailing address (he replied 2026-05-18 with payment
 * + address). Fires the stage-update email to alex@mento.co.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const MENTO_ENTITY_ID = 'f92264b1-d420-4865-93f0-33943fc507ff';

const { data: ent } = await sb.from('request_entities')
  .select('id, entity_name, gross_receipts').eq('id', MENTO_ENTITY_ID).single();
if (!ent) { console.error('Mento entity not found'); process.exit(1); }

const recovery = ent.gross_receipts?.erc_recovery || {};
const now = new Date().toISOString();

const newAddress = {
  address1: '12234 Montana Ave, Apt 301',
  city: 'Los Angeles',
  state: 'CA',
  zip: '90049',
};

const newHistoryEntry = {
  stage: 'intake_complete',
  at: now,
  actor: 'matt@moderntax.io',
  merchant_visible_note: 'Mercury invoice paid + new mailing address received (12234 Montana Ave, Apt 301, Los Angeles, CA 90049). Expert call to IRS Business & Specialty Tax Line scheduled for Monday 7 AM ET.',
  internal_note: 'Alex Marcus replied via email 2026-05-18 9:06 AM with payment confirmation + mailing address. Set up Monday morning IRS call.',
};

const updatedRecovery = {
  ...recovery,
  current_stage: 'intake_complete',
  new_mailing_address: newAddress,
  stage_history: [...(Array.isArray(recovery.stage_history) ? recovery.stage_history : []), newHistoryEntry],
};

const { error } = await sb.from('request_entities')
  .update({ gross_receipts: { ...ent.gross_receipts, erc_recovery: updatedRecovery } })
  .eq('id', MENTO_ENTITY_ID);
if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
console.log('✓ Mento engagement advanced to intake_complete');
console.log(`✓ Mailing address captured: ${newAddress.address1}, ${newAddress.city}, ${newAddress.state} ${newAddress.zip}`);

// Fire the stage update email
const { sendErcStageUpdate } = await import('../lib/sendgrid.ts');
await sendErcStageUpdate({
  toEmail: 'alex@mento.co',
  toName: 'Alex Marcus',
  entityName: ent.entity_name,
  stageLabel: 'Ready to file',
  stageMerchantCopy: 'All required info received — call to IRS scheduled.',
  customNote: newHistoryEntry.merchant_visible_note,
  trackingUrl: 'https://portal.moderntax.io/erc-status/mento-recovery',
});
console.log('✓ Stage update email fired to alex@mento.co');
