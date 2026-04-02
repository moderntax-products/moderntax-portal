/**
 * Dropbox Sign (HelloSign) API Helper
 * Handles sending 8821 consent forms, downloading signed PDFs, and reminders.
 */

import * as DropboxSign from '@dropbox/sign';

const API_KEY = process.env.DROPBOX_SIGN_API_KEY || '';

// Template IDs
const TEMPLATE_INDIVIDUAL = 'a34ce6060750406fc9464d1d46bf99e053c1c177'; // 1040
const TEMPLATE_BUSINESS = '6e08048317bb0efd8cf976c2cc14159ca51ef584'; // 1065, 1120, 1120S

function getApi(): DropboxSign.SignatureRequestApi {
  const api = new DropboxSign.SignatureRequestApi();
  api.username = API_KEY;
  return api;
}

/**
 * Pick the correct template based on form type
 */
function getTemplateId(formType: string): string {
  if (formType === '1040') return TEMPLATE_INDIVIDUAL;
  return TEMPLATE_BUSINESS; // 1065, 1120, 1120S
}

/**
 * Send a signature request for an 8821 form using a template
 */
export async function sendSignatureRequest(entity: {
  id: string;
  entity_name: string;
  form_type: string;
  signer_first_name: string | null;
  signer_last_name: string | null;
}, signerEmail: string): Promise<{ signatureRequestId: string }> {
  const api = getApi();
  const templateId = getTemplateId(entity.form_type);
  const signerName = [entity.signer_first_name, entity.signer_last_name]
    .filter(Boolean)
    .join(' ') || entity.entity_name;

  const data: DropboxSign.SignatureRequestSendWithTemplateRequest = {
    templateIds: [templateId],
    signers: [
      {
        role: 'Taxpayer',
        name: signerName,
        emailAddress: signerEmail,
      },
    ],
    subject: `Form 8821 — Tax Information Authorization for ${entity.entity_name}`,
    message: `Please sign this IRS Form 8821 to authorize ModernTax to obtain tax transcripts on behalf of ${entity.entity_name}. This authorization is required to process your tax verification request.`,
    metadata: {
      entity_id: entity.id,
      entity_name: entity.entity_name,
      form_type: entity.form_type,
    },
  };

  const result = await api.signatureRequestSendWithTemplate(data);
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
