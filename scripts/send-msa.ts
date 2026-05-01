/**
 * Send amended MSAs to Centerstone + TMC via Dropbox Sign.
 *
 * Renders a personalized PDF per customer (Tier B with their respective
 * deposit clauses) and triggers a Dropbox Sign signature request with both
 * the customer signer and Matt as countersigner.
 *
 * Run:
 *   npx tsx scripts/send-msa.ts <target>      [--write-only | --send]
 *     targets: centerstone | tmc | all
 *     default mode is --write-only (renders PDF to /tmp, doesn't send)
 *     pass --send to actually trigger Dropbox Sign
 */

import { writeFile } from 'fs/promises';
import { config } from 'dotenv';
config({ path: '.env.local' });

import * as DropboxSign from '@dropbox/sign';
import { Readable } from 'stream';
import { renderMsaPdf, type MsaPdfInput } from '../lib/msa-pdf';

const target = process.argv[2] || '';
const send = process.argv.includes('--send');
const writeOnly = !send;

if (!['centerstone', 'tmc', 'blank', 'all'].includes(target)) {
  console.error('Usage: npx tsx scripts/send-msa.ts <centerstone|tmc|blank|all> [--send]');
  process.exit(1);
}

const CENTERSTONE: MsaPdfInput = {
  customer: {
    name: 'Centerstone SBA Lending, Inc.',
    address: '915 Wilshire Blvd., Suite 1700, Los Angeles, CA 90017',
    noticeEmail: 'mathew.paek@teamcenterstone.com',
    signerName: 'Mathew Paek',
    signerTitle: 'FVP & Credit Manager',
  },
  effectiveDate: '2026-06-01',
  selectedTier: 'B',
  netDays: 30,
  depositClause: 'Client made a $1,000 onboarding deposit on September 15, 2025 under the prior Order Form, which has been applied as credit toward usage and is fully reconciled as of the Effective Date. In recognition of Client\'s existing relationship and continuous engagement since September 2025, Client is grandfathered into Tier B (Deposit/Onboarding) without requiring a top-up to the standard $2,500 deposit amount. Client\'s Verification rate is $59.98 per TIN per Section 2.1.B.',
};

const TMC: MsaPdfInput = {
  customer: {
    name: 'TMC Financing, LLC',
    address: '1611 Telegraph Ave, Suite 504, Oakland, CA 94612',
    noticeEmail: 'grace@tmcfinancing.com',
    signerName: 'Grace Quintin',
    signerTitle: 'AVP, Loan Processing Manager',
  },
  effectiveDate: '2026-06-01',
  selectedTier: 'B',
  netDays: 30,
  depositClause: 'Client shall pay an onboarding deposit of $2,500.00 (covered by ModernTax invoice INV-16, due May 5, 2026). The deposit is applied as credit against Client\'s first month(s) of usage at the Verification rate of $59.98 per TIN per Section 2.1.B. No further deposit is required after the initial credit is exhausted.',
};

function bufferToStream(buffer: Buffer, filename: string): any {
  const stream = Readable.from(buffer) as any;
  stream.path = filename;
  stream.name = filename;
  return stream;
}

async function sendForCustomer(input: MsaPdfInput, signerEmail: string, ccEmails: string[]): Promise<{ pdfPath: string; signatureRequestId?: string }> {
  const bytes = await renderMsaPdf(input);
  const filenameBase = input.customer.name
    .replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/_$/, '');
  const filename = `ModernTax_MSA_${filenameBase}_2026-06-01.pdf`;
  const pdfPath = `/tmp/${filename}`;
  await writeFile(pdfPath, bytes);
  console.log(`PDF rendered: ${pdfPath} (${bytes.length} bytes, ${input.selectedTier} tier)`);

  if (writeOnly) return { pdfPath };

  // Trigger Dropbox Sign signature request
  const apiKey = process.env.DROPBOX_SIGN_API_KEY;
  if (!apiKey) throw new Error('DROPBOX_SIGN_API_KEY not configured');
  const api = new DropboxSign.SignatureRequestApi();
  api.username = apiKey;

  const sigRequest = new DropboxSign.SignatureRequestSendRequest();
  // Allow optional --test-mode flag so we can verify the code path even when
  // the production API plan is paused (signatures from test mode are not
  // legally binding and watermark "TEST" but the request flow is identical).
  if (process.argv.includes('--test-mode')) {
    (sigRequest as any).testMode = true;
    console.log('[test-mode] signature request will be marked as TEST (not legally binding)');
  }
  sigRequest.files = [bufferToStream(Buffer.from(bytes), filename)];
  // Order matters: customer signs first (order=0), Matt countersigns (order=1).
  sigRequest.signers = [
    { emailAddress: signerEmail, name: input.customer.signerName, order: 0 },
    { emailAddress: 'matt@moderntax.io', name: 'Matthew Parker', order: 1 },
  ];
  if (ccEmails.length > 0) sigRequest.ccEmailAddresses = ccEmails;
  sigRequest.subject = `ModernTax Master Services Agreement - ${input.customer.name}`;
  sigRequest.message = `Hi ${input.customer.signerName.split(' ')[0]},\n\nAttached is the amended Master Services Agreement for ${input.customer.name}, effective June 1, 2026. This consolidates and supersedes the prior order form and standardizes our pricing across customers.\n\nKey terms:\n  - Tier B (Deposit/Onboarding) at $59.98 per TIN verification\n  - $25/TIN/month account monitoring (until cancelled)\n  - $19.99 entity transcript add-on\n  - $10 ModernTax-prepared 8821 generation surcharge\n  - 24-48 hour delivery SLA\n  - Net 30, ACH via Mercury\n\nReply to this email or matt@moderntax.io with any questions before signing.\n\nThanks,\nMatt`;
  sigRequest.metadata = {
    customer_name: input.customer.name,
    selected_tier: input.selectedTier,
    effective_date: input.effectiveDate,
  };

  const result = await api.signatureRequestSend(sigRequest);
  const signatureRequestId = result.body?.signatureRequest?.signatureRequestId;
  console.log(`Dropbox Sign request sent → ${signerEmail} (CC ${ccEmails.join(', ') || 'none'})`);
  console.log(`  signature_request_id: ${signatureRequestId}`);
  return { pdfPath, signatureRequestId };
}

// Customer-agnostic blank template for future signups. All three tiers visible
// with no [X] selection so Matt can mark the chosen tier and fill in the
// customer block in Dropbox Sign's web UI before sending.
const BLANK_TEMPLATE: MsaPdfInput = {
  customer: {
    name: '[Customer Legal Name]',
    address: '[Customer Address]',
    noticeEmail: '[customer-notice-email@domain.com]',
    signerName: '[Signer Name]',
    signerTitle: '[Signer Title]',
  },
  effectiveDate: '2026-06-01',
  // Force "no tier selected" so all three render unhighlighted with empty checkboxes
  selectedTier: 'X' as any,
  netDays: 30,
  depositClause: '[If Tier B selected: insert deposit clause here. Standard language: "Client shall pay an onboarding deposit of $2,500.00 prior to or on the Effective Date. The deposit is applied as credit against Client\'s first month(s) of usage at the Verification rate of $59.98 per TIN per Section 2.1.B. No further deposit is required after the initial credit is exhausted."]',
};

async function main() {
  if (target === 'centerstone' || target === 'all') {
    await sendForCustomer(CENTERSTONE, 'mathew.paek@teamcenterstone.com', ['jasmine.kim@teamcenterstone.com']);
  }
  if (target === 'tmc' || target === 'all') {
    await sendForCustomer(TMC, 'grace@tmcfinancing.com', ['kisha@tmcfinancing.com']);
  }
  if (target === 'blank' || target === 'all') {
    await sendForCustomer(BLANK_TEMPLATE, '[signer-email]', []);
  }
  if (writeOnly) {
    console.log('\nWRITE-ONLY mode (default). Re-run with --send to trigger Dropbox Sign.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
