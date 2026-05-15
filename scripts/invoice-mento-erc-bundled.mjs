/**
 * Post-call consolidation (2026-05-15, ~3pm PT, after Matt's call with Alex Marcus).
 *
 * Replace the 2 separate drafts with ONE bundled invoice ($1,479) for simplicity.
 * Alex agreed verbally to the pitch; fire SendNow.
 *
 * Bundled line items:
 *   1. ERC Refund Recovery Bundle (compliance + recovery strategy) — $479
 *   2. ERC Check Reissue — Q3 2021 ($35,449.33, returned 08-29-2022) — $500
 *   3. ERC Check Reissue — Q4 2021 ($32,648.80, returned 08-29-2022) — $500
 *   Total: $1,479
 *
 * Also try to cancel the two original drafts:
 *   · 1209d5c2-50a9-11f1-8a87-4f0dd60a9e53  (Bundle-only draft, $479)
 *   · 122e6eb4-50a9-11f1-a3ad-21e47c48f252  (Reissues-only draft, $1000)
 *
 * Matt's verbal commitments on the call (reflected in invoice + payer memo):
 *   · 3–6 week timeline (returned-check reissue is faster than lost/stolen path)
 *   · Weekly tracking + login portal access
 *   · Monday: pay + complete intake form → expert calls IRS Business & Specialty line
 *   · Alex will provide a new mailing address (not his personal)
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

// 1. Confirm customer exists (will find existing — same email)
const customer = await findOrCreateMercuryCustomer({
  name: 'Mento Technologies, Inc.',
  email: 'alex@mento.co',
});
console.log(`✓ Mercury customer: ${customer.name} <${customer.email}>  id=${customer.id}`);
console.log();

// 2. Try to cancel the two prior drafts
const PRIOR_DRAFT_IDS = [
  '1209d5c2-50a9-11f1-8a87-4f0dd60a9e53', // Bundle-only $479 draft
  '122e6eb4-50a9-11f1-a3ad-21e47c48f252', // Reissues-only $1000 draft
];

async function tryCancelInvoice(id) {
  const apiKey = process.env.MERCURY_API_KEY;
  const base = 'https://api.mercury.com/api/v1';
  // Mercury API has /ar/invoices/{id}/cancel per current docs
  const res = await fetch(`${base}/ar/invoices/${id}/cancel`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  if (res.ok) return { ok: true };
  const body = await res.text().catch(() => '');
  return { ok: false, status: res.status, body };
}

console.log('Cancelling prior drafts:');
for (const id of PRIOR_DRAFT_IDS) {
  const r = await tryCancelInvoice(id);
  if (r.ok) console.log(`  ✓ Cancelled ${id.slice(0,8)}`);
  else console.log(`  ⚠ Could not cancel ${id.slice(0,8)} via API (${r.status}). Cancel via Mercury UI: AR → Invoices → Drafts → click → ⋮ → Cancel.`);
}
console.log();

// 3. Create the bundled invoice
const bundled = await createMercuryInvoice({
  customerId: customer.id,
  destinationAccountId: getDestinationAccountId(),
  invoiceDate: today,
  dueDate: dueIn7,
  invoiceNumber: `MNT-MENTO-ERC-${dateTag}-01`,
  lineItems: [
    {
      name: 'ERC Refund Recovery Bundle — Q3 + Q4 2021 ($68,098.13 recoverable)',
      unitPrice: 479,
      quantity: 1,
    },
    {
      name: 'ERC Check Reissue — Q3 2021 ($35,449.33, returned 08-29-2022) — Form 3911 trace, expert-led, weekly tracking until reissue (3–6 wks).',
      unitPrice: 500,
      quantity: 1,
    },
    {
      name: 'ERC Check Reissue — Q4 2021 ($32,648.80, returned 08-29-2022) — Form 3911 trace, expert-led, weekly tracking until reissue (3–6 wks).',
      unitPrice: 500,
      quantity: 1,
    },
  ],
  achDebitEnabled: true,
  creditCardEnabled: false,
  sendEmailOption: 'SendNow',
  internalNote:
    'Mento ERC engagement — full bundle post-call 2026-05-15 with Alex Marcus (CEO). ' +
    '$479 recovery bundle + $1,000 flat for both Q3+Q4 2021 check reissues (discounted from ' +
    '$1,000/check). Alex confirmed verbally. Will provide non-personal mailing address ' +
    'next week. Monday workflow: Alex pays + completes intake form → expert calls IRS ' +
    'Business & Specialty Tax Line (1-800-829-4933) → trace initiated → 3–6 wk reissue.',
  payerMemo:
    'ERC Refund Recovery + Check Reissue (2 quarters) for Mento Technologies, Inc. ' +
    'Total recoverable from IRS: $68,098.13 (Q3 2021 $35,449.33 + Q4 2021 $32,648.80, ' +
    'both originally issued 08-29-2022, both returned to IRS uncashed). Expert-led trace ' +
    'via IRS Business & Specialty Tax Line, weekly status tracking with portal access, ' +
    '3–6 week expected delivery from trace initiation.',
});

console.log('✓ Bundled Invoice (SendNow — email firing to alex@mento.co now):');
console.log(`    Invoice #:   ${bundled.invoiceNumber}`);
console.log(`    Invoice ID:  ${bundled.id}`);
console.log(`    Amount:      $${bundled.amount.toFixed(2)}`);
console.log(`    Status:      ${bundled.status}`);
console.log(`    Due:         ${bundled.dueDate}`);
console.log(`    Pay URL:     ${getMercuryPayUrl(bundled.slug)}`);
console.log();
console.log('Line items:');
for (const li of bundled.lineItems) console.log(`  · $${li.unitPrice.toFixed(2)} × ${li.quantity} — ${li.name}`);
console.log();
console.log(`Total: $${bundled.amount.toFixed(2)} due ${bundled.dueDate} (Net 7, ACH only).`);
console.log(`Mercury just emailed Alex with the pay link above.`);
