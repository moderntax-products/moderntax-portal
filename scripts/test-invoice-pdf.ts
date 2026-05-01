/**
 * Quick visual test of the invoice PDF layout.
 * Run: npx tsx scripts/test-invoice-pdf.ts
 * Output: /tmp/invoice-test.pdf
 */
import { writeFile } from 'fs/promises';
import { renderInvoicePdf } from '../lib/invoice-pdf';

async function main() {
  const bytes = await renderInvoicePdf({
    invoiceNumber: 'INV-2026-04-CENT',
    invoiceDate: '2026-05-01',
    dueDate: '2026-05-06',
    billingPeriodStart: '2026-04-01',
    billingPeriodEnd: '2026-04-30',
    paymentTerms: 'Net 5 - ACH',
    payUrl: 'https://app.mercury.com/pay/wxfn2cvr5px933hs',
    client: {
      name: 'Centerstone SBA Lending',
      addressLine1: '2 Embarcadero, 8th Floor',
      city: 'San Francisco',
      state: 'CA',
      postalCode: '94111',
    },
    verificationGroups: [
      {
        processorName: 'Justin Kim',
        entities: [
          { entityName: 'Cheng Fu Hui', formType: '1040', loanNumber: '18016', completedAt: '03/20/2026', unitPrice: 59.98 },
          { entityName: "David's Auto, Inc.", formType: '1120S', loanNumber: '18016', completedAt: '03/23/2026', unitPrice: 59.98 },
          { entityName: '7 M&D Holdings, LLC', formType: '1120S', loanNumber: '18024', completedAt: '03/27/2026', unitPrice: 59.98 },
          { entityName: 'Scott Donkel', formType: '1040', loanNumber: '18024', completedAt: '04/01/2026', unitPrice: 59.98 },
          { entityName: 'Patrick Donkel', formType: '1040', loanNumber: '18024', completedAt: '04/01/2026', unitPrice: 59.98 },
          { entityName: 'Rodney Phillips Sr', formType: '1040', loanNumber: '18024', completedAt: '04/01/2026', unitPrice: 59.98 },
        ],
      },
      {
        processorName: 'Timothy Suk',
        entities: [
          { entityName: 'Lillian Aguirre', formType: '1040', loanNumber: '18022', completedAt: '03/19/2026', unitPrice: 59.98 },
          { entityName: 'J Issac Aguirre', formType: '1040', loanNumber: '18022', completedAt: '03/20/2026', unitPrice: 59.98 },
          { entityName: 'McKenzie Carter', formType: '1040', loanNumber: '18027', completedAt: '03/27/2026', unitPrice: 59.98 },
          { entityName: 'Cynthia Carter', formType: '1040', loanNumber: '18027', completedAt: '04/06/2026', unitPrice: 59.98 },
        ],
      },
      {
        processorName: 'Robin Kim',
        entities: [
          { entityName: 'Misha LLC', formType: '1120S', loanNumber: 'countryside', completedAt: '03/25/2026', unitPrice: 59.98 },
          { entityName: 'Sunrise AAA Inc', formType: '1120S', loanNumber: '18025', completedAt: '04/03/2026', unitPrice: 59.98 },
        ],
      },
    ],
    entityTranscripts: [],
    selfSigned8821: { count: 12, unitPrice: 10, total: 120 },
    monitoringGroups: [
      {
        processorName: 'Soobin Song',
        items: [
          { description: 'Justin Pizzola - Monitoring Enrollment (Weekly)', loanNumber: '18018', date: '04/06/2026', unitPrice: 19.99 },
          { description: 'Justin Pizzola - Initial Monitoring Pull', loanNumber: '18018', date: '04/06/2026', unitPrice: 39.99 },
          { description: 'Justin Pizzola - Monitoring Update Pull', loanNumber: '18018', date: '04/13/2026', unitPrice: 39.99 },
          { description: 'Justin Pizzola - Monitoring Update Pull', loanNumber: '18018', date: '04/20/2026', unitPrice: 39.99 },
        ],
      },
    ],
    notes: [
      'Payment via ACH. Mercury delivers the formal invoice + pay link separately.',
      'Auto-pay enrollment is one click on the Mercury pay page - saves us both the back-and-forth.',
      "Questions? Reply to this email and I'll dig in.",
    ],
  });
  await writeFile('/tmp/invoice-test.pdf', bytes);
  console.log(`Wrote ${bytes.length} bytes → /tmp/invoice-test.pdf`);
}
main().catch(e => { console.error(e); process.exit(1); });
