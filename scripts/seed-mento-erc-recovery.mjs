/**
 * MVP seed — write Mento's ERC recovery data into the existing
 * gross_receipts JSONB column (no migration needed) so the merchant-facing
 * page can render the findings + step-by-step process.
 *
 * Token is stored as a key inside gross_receipts so the URL is
 * /erc-status/{token} without any schema change.
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
const TOKEN = 'mento-recovery'; // predictable, easy to verbally share

const recoveryData = {
  erc_recovery_token: TOKEN,
  erc_recovery: {
    engagement_created_at: new Date().toISOString(),
    total_recoverable: 68098.13,
    total_issued: 68098.13,
    total_delivered: 0,
    total_undelivered: 68098.13,
    events: [
      {
        tax_quarter: '2021-Q3',
        period_ending: '09-30-2021',
        form_type: '941',
        issued_on: '08-29-2022',
        amount: 35449.33,
        status: 'undelivered',
        returned_on: '08-29-2022',
        notes: 'TC 740 same day as TC 846 — check returned to IRS uncashed.',
      },
      {
        tax_quarter: '2021-Q4',
        period_ending: '12-31-2021',
        form_type: '941',
        issued_on: '08-29-2022',
        amount: 32648.80,
        status: 'undelivered',
        returned_on: '08-29-2022',
        notes: 'TC 740 same day as TC 846 — check returned to IRS uncashed.',
      },
    ],
    current_stage: 'engagement_created',
    // Stage progression matches what shows on the merchant tracking page
    stage_history: [
      {
        stage: 'engagement_created',
        at: new Date().toISOString(),
        actor: 'matt@moderntax.io',
        merchant_visible_note: 'Engagement kicked off after CEO call with Alex Marcus (2026-05-15). $1,479 bundled invoice fired to alex@mento.co.',
      },
    ],
    invoice: {
      mercury_invoice_number: 'MNT-MENTO-ERC-20260515-01',
      amount: 1479.00,
      pay_url: 'https://app.mercury.com/pay/gyshk5blfwkn26my',
    },
  },
};

const { data: ent } = await sb.from('request_entities')
  .select('id, entity_name, gross_receipts').eq('id', MENTO_ENTITY_ID).single();

const merged = { ...(ent.gross_receipts || {}), ...recoveryData };
const { error } = await sb.from('request_entities')
  .update({ gross_receipts: merged })
  .eq('id', MENTO_ENTITY_ID);
if (error) { console.error(`✗ ${error.message}`); process.exit(1); }

const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';
console.log(`✓ Backfilled ${ent.entity_name} with ERC recovery data + token "${TOKEN}"`);
console.log(`   $${recoveryData.erc_recovery.total_undelivered.toFixed(2)} recoverable across ${recoveryData.erc_recovery.events.length} quarters`);
console.log();
console.log(`Merchant URL:  ${appUrl}/erc-status/${TOKEN}`);
console.log(`Local preview: http://localhost:3000/erc-status/${TOKEN}`);
