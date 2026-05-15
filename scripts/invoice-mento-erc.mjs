/**
 * Fire two Mercury invoice DRAFTS for Mento Technologies, Inc.
 * (DontSend mode — Matt clicks Send in Mercury post-call with Alex Marcus).
 *
 * Invoice 1: ERC Refund Recovery Bundle — $479
 * Invoice 2: ERC Check Reissue × 2 (combined, $1,000 flat — discounted from
 *            standard $1,000-per-check rate) — $500 line × 2
 *
 * Recipient: Alex Marcus <alex@mento.co> (Mento CEO)
 *
 * Two checks being reissued (data from IRS account transcripts pulled
 * via 8821 — Form 941 quarterly):
 *   · Q3 2021 (period 09-30-2021): $35,449.33 issued 08-29-2022, returned to IRS
 *   · Q4 2021 (period 12-31-2021): $32,648.80 issued 08-29-2022, returned to IRS
 *   Total recoverable: $68,098.13
 */

import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { findOrCreateMercuryCustomer, createMercuryInvoice, getDestinationAccountId, getMercuryPayUrl } =
  await import('../lib/mercury.ts');

const today = new Date().toISOString().slice(0, 10);
const dueIn7 = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
const dateTag = today.replace(/-/g, '');

// -----------------------------------------------------------------------------
// 1. Find or create Mercury customer for Mento
// -----------------------------------------------------------------------------

const customer = await findOrCreateMercuryCustomer({
  name: 'Mento Technologies, Inc.',
  email: 'alex@mento.co',
  // Address intentionally omitted — Mento's NEW mailing address is being
  // collected post-call. Mercury allows customers without address; the
  // payer's billing address gets captured at pay-time when they enter ACH.
});
console.log(`✓ Mercury customer: ${customer.name} <${customer.email}>  id=${customer.id}`);
console.log();

// -----------------------------------------------------------------------------
// 2. Invoice 1 — ERC Refund Recovery Bundle ($479)
// -----------------------------------------------------------------------------

const bundleInvoice = await createMercuryInvoice({
  customerId: customer.id,
  destinationAccountId: getDestinationAccountId(),
  invoiceDate: today,
  dueDate: dueIn7,
  invoiceNumber: `MNT-MENTO-BUNDLE-${dateTag}-01`,
  lineItems: [
    {
      name: 'ERC Refund Recovery Bundle — Q3 + Q4 2021 ($68,098.13 surfaced)',
      unitPrice: 479,
      quantity: 1,
    },
  ],
  achDebitEnabled: true,
  creditCardEnabled: false,
  sendEmailOption: 'DontSend',
  internalNote:
    'Mento ERC Refund Recovery Bundle — sold on 2026-05-15 CEO call (Alex Marcus). ' +
    'Productized from initial Mento discovery work that surfaced $68,098.13 in returned ' +
    'ERC refund checks (Q3 + Q4 2021). DRAFT status: Matt will hit Send in Mercury after call confirms.',
  payerMemo:
    'ERC Refund Recovery — full transcript audit + Form 3911 strategy + expert-led IRS trace ' +
    'initiation + 6-8 week tracked delivery to mailbox. Two undelivered ERC refund checks ' +
    '($68,098.13 total) identified in Mento\'s IRS account.',
});
console.log(`✓ Invoice 1 — ERC Bundle:`);
console.log(`    Invoice #:   ${bundleInvoice.invoiceNumber}`);
console.log(`    Invoice ID:  ${bundleInvoice.id}`);
console.log(`    Amount:      $${bundleInvoice.amount.toFixed(2)}`);
console.log(`    Status:      ${bundleInvoice.status} (DRAFT — not sent)`);
console.log(`    Pay URL:     ${getMercuryPayUrl(bundleInvoice.slug)}`);
console.log();

// -----------------------------------------------------------------------------
// 3. Invoice 2 — ERC Check Reissue × 2 (combined, $1,000 discounted)
// -----------------------------------------------------------------------------

const reissueInvoice = await createMercuryInvoice({
  customerId: customer.id,
  destinationAccountId: getDestinationAccountId(),
  invoiceDate: today,
  dueDate: dueIn7,
  invoiceNumber: `MNT-MENTO-3911-${dateTag}-01`,
  lineItems: [
    {
      name: 'ERC Check Reissue — Q3 2021 ($35,449.33, returned 08-29-2022) — Form 3911 trace, expert-led, tracked until reissue (6–8 wks). Bundle-discounted.',
      unitPrice: 500,
      quantity: 1,
    },
    {
      name: 'ERC Check Reissue — Q4 2021 ($32,648.80, returned 08-29-2022) — Form 3911 trace, expert-led, tracked until reissue (6–8 wks). Bundle-discounted.',
      unitPrice: 500,
      quantity: 1,
    },
  ],
  achDebitEnabled: true,
  creditCardEnabled: false,
  sendEmailOption: 'DontSend',
  internalNote:
    'Mento Form 3911 / ERC Check Reissue × 2. Discounted bundle price: $1,000 flat for both ' +
    'reissues vs. standard $1,000/check rate ($2,000 if billed separately). $1,000 discount ' +
    'applied per Matt 2026-05-15 CEO call. DRAFT status: Matt will hit Send in Mercury after ' +
    'call confirms.',
  payerMemo:
    'ERC Check Reissue — Form 3911 / IRS refund trace for the two returned ERC refund checks ' +
    '(Q3 2021 $35,449.33 + Q4 2021 $32,648.80 = $68,098.13 total). Expert-led, end-to-end, ' +
    'tracked until check is in the mail. Standard reissue timeline: 6–8 weeks from trace.',
});
console.log(`✓ Invoice 2 — ERC Check Reissue × 2 (discounted bundle):`);
console.log(`    Invoice #:   ${reissueInvoice.invoiceNumber}`);
console.log(`    Invoice ID:  ${reissueInvoice.id}`);
console.log(`    Amount:      $${reissueInvoice.amount.toFixed(2)}`);
console.log(`    Status:      ${reissueInvoice.status} (DRAFT — not sent)`);
console.log(`    Pay URL:     ${getMercuryPayUrl(reissueInvoice.slug)}`);
console.log();

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

const total = bundleInvoice.amount + reissueInvoice.amount;
console.log('─────────────────────────────────────────────');
console.log(`Combined total queued (DRAFT): $${total.toFixed(2)}`);
console.log(`  · ERC Bundle:           $${bundleInvoice.amount.toFixed(2)}`);
console.log(`  · 2× Check Reissue:     $${reissueInvoice.amount.toFixed(2)}`);
console.log();
console.log(`Both invoices are in DRAFT (DontSend) status. Open Mercury → AR → Invoices → "Draft"`);
console.log(`tab to review and click Send when ready. Customer is "Mento Technologies, Inc." /`);
console.log(`alex@mento.co. ACH-only, no credit card. Net 7 (due ${dueIn7}).`);
