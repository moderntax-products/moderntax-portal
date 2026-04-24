/**
 * Send 8821 signature request for Centerstone Request — Loan #18015
 *
 * Entity: YUG LLC — EIN 82-1722107, 1120S
 * Signer: Jignesh Patel <Jignesh100@gmail.com>
 * Designee: LaTonya Holmes (default)
 *
 * Uses generate8821PDF for pre-filled PDF + file-based Dropbox Sign request.
 */

import * as DropboxSign from '@dropbox/sign';
import { createClient } from '@supabase/supabase-js';
import { Readable } from 'stream';
import * as dotenv from 'dotenv';
import path from 'path';
import { generate8821PDF, DESIGNEES } from '../lib/8821-pdf';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const API_KEY = process.env.DROPBOX_SIGN_API_KEY || '';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const REQUEST_ID = '31b859b1-4691-446b-bb6c-955333c793ab';
const DESIGNEE = DESIGNEES.default;

function bufferToStream(buffer: Buffer, filename: string): any {
  const stream = Readable.from(buffer) as any;
  stream.path = filename;
  stream.name = filename;
  return stream;
}

async function main() {
  const api = new DropboxSign.SignatureRequestApi();
  api.username = API_KEY;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Fetch entities for this request
  const { data: entities, error: fetchError } = await supabase
    .from('request_entities')
    .select('id, entity_name, tid, tid_kind, form_type, status, signature_id, signer_email, signer_first_name, signer_last_name, address, city, state, zip_code')
    .eq('request_id', REQUEST_ID);

  if (fetchError || !entities) {
    console.error('Failed to fetch entities:', fetchError);
    return;
  }

  console.log(`Found ${entities.length} entities for request ${REQUEST_ID}:`);
  entities.forEach((e: any) => console.log(`  - ${e.entity_name} (${e.tid}) — status: ${e.status}, sig: ${e.signature_id || 'none'}`));

  for (const entity of entities) {
    if (entity.signature_id) {
      console.log(`\n⏭️  Skipping ${entity.entity_name} — already has signature_id: ${entity.signature_id}`);
      continue;
    }

    if (!entity.signer_email) {
      console.log(`\n⏭️  Skipping ${entity.entity_name} — no signer email`);
      continue;
    }

    const formType = (entity.form_type || '1040') as '1040' | '1065' | '1120' | '1120S';
    const signerName = [entity.signer_first_name, entity.signer_last_name]
      .filter(Boolean)
      .join(' ') || entity.entity_name;
    const entityAddress = [entity.address, entity.city, entity.state, entity.zip_code]
      .filter(Boolean)
      .join(', ') || '';

    console.log(`\nGenerating 8821 PDF for ${entity.entity_name}...`);
    console.log(`  Form Type: ${formType}`);
    console.log(`  Signer: ${signerName} <${entity.signer_email}>`);
    console.log(`  TID: ${entity.tid}`);
    console.log(`  Address: ${entityAddress}`);
    console.log(`  Designee: ${DESIGNEE.name}`);

    // Generate filled PDF
    const pdfBuffer = await generate8821PDF({
      taxpayer: {
        name: entity.entity_name || '',
        tin: entity.tid || '',
        address: entityAddress,
      },
      designee: DESIGNEE,
      formType,
    });

    console.log(`  PDF generated (${pdfBuffer.length} bytes)`);

    // Send via Dropbox Sign (file-based, no testMode)
    const sigRequest = new DropboxSign.SignatureRequestSendRequest();
    sigRequest.testMode = true; // Required on free API plan
    sigRequest.files = [bufferToStream(pdfBuffer, `8821-${entity.entity_name.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`)];
    sigRequest.signers = [{
      emailAddress: entity.signer_email,
      name: signerName,
      order: 0,
    }];
    sigRequest.ccEmailAddresses = ['matt@moderntax.io'];
    sigRequest.subject = `Form 8821 — Tax Information Authorization for ${entity.entity_name}`;
    sigRequest.message = `Please sign this IRS Form 8821 to authorize ModernTax to obtain tax transcripts on behalf of ${entity.entity_name}. Please print your name on the "Print Name" line, add your title (if applicable), then sign and date. Designee: ${DESIGNEE.name} (PTIN: ${DESIGNEE.ptin}, CAF: ${DESIGNEE.caf}).`;
    sigRequest.metadata = {
      entity_id: entity.id,
      entity_name: entity.entity_name,
      form_type: entity.form_type,
      request_id: REQUEST_ID,
      client: 'centerstone',
      designee_name: DESIGNEE.name,
      designee_ptin: DESIGNEE.ptin,
      designee_caf: DESIGNEE.caf,
    };
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

    console.log(`  Sending to Dropbox Sign...`);

    try {
      const result = await api.signatureRequestSend(sigRequest);
      const signatureRequestId = result.body?.signatureRequest?.signatureRequestId;

      if (signatureRequestId) {
        console.log(`  ✅ Sent! Signature Request ID: ${signatureRequestId}`);

        // Update DB
        const { error: updateError } = await supabase
          .from('request_entities')
          .update({
            signature_id: signatureRequestId,
            status: '8821_sent',
          })
          .eq('id', entity.id);

        if (updateError) {
          console.error(`  ⚠️  DB update failed:`, updateError.message);
        } else {
          console.log(`  ✅ DB updated — status: 8821_sent`);
        }
      } else {
        console.error(`  ❌ No signature request ID returned`);
      }
    } catch (err: any) {
      console.error(`  ❌ Error:`, err?.body || err?.message || err);
    }
  }

  console.log('\nDone!');
}

main();
