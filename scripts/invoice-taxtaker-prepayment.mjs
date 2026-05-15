/**
 * Fire a Mercury prepayment invoice to Ari Salafia (TaxTaker, Inc.) for
 * the 3 new requests she submitted this morning (2026-05-15) at PAYG rate.
 *
 *   loan 124  Ram Threading, Inc.        1120 / 2021
 *   loan 125  Alternative Finance, Inc.  1120 / 2020, 2021
 *   loan 126  Pluto Biosciences, Inc.    1120 / 2020, 2021
 *
 * TaxTaker PAYG rate (billing_rate_pdf): $59.98 per entity
 * Total: 3 entities × $59.98 = $179.94
 *
 * Why Mercury (not Stripe): Matt's 2026-05-14 directive — avoiding Stripe
 * until the existing Stripe processing balance settles. All new client
 * billing routes through Mercury ACH.
 */

import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { createMercuryInvoice, getDestinationAccountId } = await import('../lib/mercury.ts');

const TAXTAKER_MERCURY_CUSTOMER_ID = '225696b6-4f16-11f1-bf01-2fd2e84bff67';
const PAYG_RATE = 59.98;

const today = new Date().toISOString().slice(0, 10);
const dueIn7Days = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);

const lineItems = [
  {
    name: 'IRS transcript pull — Ram Threading, Inc. (1120 / 2021) · loan 124',
    unitPrice: PAYG_RATE,
    quantity: 1,
  },
  {
    name: 'IRS transcript pull — Alternative Finance, Inc. (1120 / 2020-2021) · loan 125',
    unitPrice: PAYG_RATE,
    quantity: 1,
  },
  {
    name: 'IRS transcript pull — Pluto Biosciences, Inc. (1120 / 2020-2021) · loan 126',
    unitPrice: PAYG_RATE,
    quantity: 1,
  },
];

const total = lineItems.reduce((s, li) => s + li.unitPrice * li.quantity, 0);

console.log(`\nFiring Mercury prepayment invoice to TaxTaker, Inc.:`);
console.log(`  Customer ID:   ${TAXTAKER_MERCURY_CUSTOMER_ID}`);
console.log(`  Destination:   ${getDestinationAccountId()}`);
console.log(`  Invoice date:  ${today}`);
console.log(`  Due date:      ${dueIn7Days} (Net 7)`);
console.log(`  Line items:`);
for (const li of lineItems) console.log(`    · $${li.unitPrice.toFixed(2)} × ${li.quantity} — ${li.name}`);
console.log(`  Total:         $${total.toFixed(2)}\n`);

const invoice = await createMercuryInvoice({
  customerId: TAXTAKER_MERCURY_CUSTOMER_ID,
  destinationAccountId: getDestinationAccountId(),
  invoiceDate: today,
  dueDate: dueIn7Days,
  invoiceNumber: `MNT-TT-PREPAY-${today.replace(/-/g, '')}-01`,
  lineItems,
  achDebitEnabled: true,
  creditCardEnabled: false,
  sendEmailOption: 'SendNow',
  internalNote: 'Prepayment invoice — 3 new TaxTaker requests submitted 2026-05-15 (Ram Threading + Alternative Finance + Pluto Biosciences). PAYG $59.98/entity. Sent before work begins per Matt directive.',
  payerMemo: 'Prepayment for 3 IRS transcript pull requests submitted 5/15/26. PAYG rate applies. Expected delivery 24-48 business hours from receipt of signed 8821 + payment.',
});

console.log(`✓ Invoice created:`);
console.log(`  Invoice ID:     ${invoice.id}`);
console.log(`  Invoice #:      ${invoice.invoiceNumber}`);
console.log(`  Status:         ${invoice.status}`);
console.log(`  Amount:         $${invoice.amount.toFixed(2)}`);
console.log(`  Pay page slug:  ${invoice.slug}`);
console.log(`  Pay page URL:   https://app.mercury.com/pay/${invoice.slug}`);
console.log(`  Created:        ${invoice.createdAt}`);
console.log();
console.log(`Mercury just emailed Ari (TaxTaker AP email on file) the invoice + ACH pay link.`);
console.log(`When she clicks the pay link + completes ACH, the auto-reconcile cron marks the invoice paid.`);
