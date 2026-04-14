/**
 * Dropbox Sign (HelloSign) API Helper
 * Handles sending 8821 consent forms, downloading signed PDFs, and reminders.
 *
 * v2: Uses file-based signature requests with server-side PDF generation
 *     via generate8821PDF. All Section 3 tax info, designee PTIN/CAF/phone,
 *     and taxpayer details are filled in the PDF before sending.
 */

import * as DropboxSign from '@dropbox/sign';
import { Readable } from 'stream';
import { generate8821PDF, DESIGNEES } from '@/lib/8821-pdf';
import type { DesigneeInfo } from '@/lib/8821-pdf';

const API_KEY = process.env.DROPBOX_SIGN_API_KEY || '';

function getApi(): DropboxSign.SignatureRequestApi {
  const api = new DropboxSign.SignatureRequestApi();
  api.username = API_KEY;
  return api;
}

/** Convert a Buffer to a ReadStream for the Dropbox Sign SDK */
function bufferToStream(buffer: Buffer, filename: string): any {
  const stream = Readable.from(buffer) as any;
  stream.path = filename;
  stream.name = filename;
  return stream;
}

/** Resolve designee from entity's designee_key or fall back to default */
function getDesignee(entity: { designee_key?: string }): DesigneeInfo {
  const key = entity.designee_key || 'default';
  return DESIGNEES[key] || DESIGNEES.default;
}

/**
 * Send a signature request for an 8821 form using a pre-filled PDF.
 *
 * Generates the PDF server-side with all form fields populated
 * (taxpayer, designee, Section 3 tax info), then sends via Dropbox Sign
 * file-based signature request with signature/date fields placed at
 * the Section 6 signature line.
 */
export async function sendSignatureRequest(entity: {
  id: string;
  entity_name: string;
  form_type: string;
  tid?: string;
  tid_kind?: string;
  signer_first_name: string | null;
  signer_last_name: string | null;
  address?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  designee_key?: string;
}, signerEmail: string): Promise<{ signatureRequestId: string }> {
  const api = getApi();
  const designee = getDesignee(entity);
  const formType = (entity.form_type || '1040') as '1040' | '1065' | '1120' | '1120S';
  const signerName = [entity.signer_first_name, entity.signer_last_name]
    .filter(Boolean)
    .join(' ') || entity.entity_name;
  const entityAddress = [entity.address, entity.city, entity.state, entity.zip_code]
    .filter(Boolean)
    .join(', ') || '';

  // Generate filled 8821 PDF
  const pdfBuffer = await generate8821PDF({
    taxpayer: {
      name: entity.entity_name || '',
      tin: entity.tid || '',
      address: entityAddress,
    },
    designee,
    formType,
  });

  // Send as file-based signature request
  const sigRequest = new DropboxSign.SignatureRequestSendRequest();
  sigRequest.testMode = true; // Required on free API plan — upgrade to remove TEST watermark
  sigRequest.files = [bufferToStream(pdfBuffer, `8821-${entity.entity_name.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`)];
  sigRequest.signers = [{
    emailAddress: signerEmail,
    name: signerName,
    order: 0,
  }];
  sigRequest.ccEmailAddresses = ['matt@moderntax.io'];
  sigRequest.subject = `Form 8821 — Tax Information Authorization for ${entity.entity_name}`;
  sigRequest.message = `Please sign this IRS Form 8821 to authorize ModernTax to obtain tax transcripts on behalf of ${entity.entity_name}. Please print your name on the "Print Name" line, add your title (if applicable), then sign and date. Designee: ${designee.name} (PTIN: ${designee.ptin}, CAF: ${designee.caf}).`;
  sigRequest.metadata = {
    entity_id: entity.id,
    entity_name: entity.entity_name,
    form_type: entity.form_type,
    designee_name: designee.name,
    designee_ptin: designee.ptin,
    designee_caf: designee.caf,
  };
  // Signature field at Section 6 signature line
  sigRequest.formFieldsPerDocument = [
    {
      documentIndex: 0,
      apiId: 'sig_taxpayer',
      type: 'signature',
      name: 'Taxpayer Signature',
      x: 58,
      y: 647,
      width: 200,
      height: 20,
      required: true,
      signer: '0',
      page: 1,
    } as any,
    {
      documentIndex: 0,
      apiId: 'date_signed',
      type: 'date_signed',
      name: 'Date Signed',
      x: 432,
      y: 647,
      width: 120,
      height: 20,
      required: true,
      signer: '0',
      page: 1,
    } as any,
  ];

  const result = await api.signatureRequestSend(sigRequest);
  const signatureRequestId = result.body?.signatureRequest?.signatureRequestId;

  if (!signatureRequestId) {
    throw new Error('No signature_request_id returned from Dropbox Sign');
  }

  return { signatureRequestId };
}

/**
 * Download the signed PDF for a completed signature request
 */
export async function downloadSignedPdf(signatureRequestId: string): Promise<Buffer> {
  const api = getApi();
  const result = await api.signatureRequestFiles(signatureRequestId, 'pdf');
  return result.body;
}

/**
 * Send a reminder to an unsigned signer
 */
export async function sendReminder(signatureRequestId: string, signerEmail: string): Promise<void> {
  const api = getApi();
  await api.signatureRequestRemind(signatureRequestId, {
    emailAddress: signerEmail,
  });
}

/**
 * Validate a Dropbox Sign event callback hash
 * Uses HMAC-SHA256 with the API key
 */
export function validateEventHash(eventType: string, eventTime: string, eventHash: string): boolean {
  const crypto = require('crypto');
  const hmac = crypto.createHmac('sha256', API_KEY);
  hmac.update(eventTime + eventType);
  const expectedHash = hmac.digest('hex');
  return expectedHash === eventHash;
}
