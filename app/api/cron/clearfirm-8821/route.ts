/**
 * Clearfirm 8821 Auto-Processing Cron
 * Runs every 15 minutes — automatically sends 8821 signature requests
 * for all new Clearfirm API entities that don't have one yet.
 *
 * Flow: Clearfirm API request → entity created → this cron picks it up →
 *       sends Dropbox Sign 8821 with LaTonya Holmes designee pre-filled →
 *       entity advances to 8821_sent → auto-sync cron picks up signed PDF →
 *       auto-assign cron assigns to expert → expert processes → completed
 *
 * Zero admin intervention required.
 *
 * GET /api/cron/clearfirm-8821
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendClearfirmBotNotification } from '@/lib/sendgrid';
import * as DropboxSign from '@dropbox/sign';

// Designee credentials for ALL Clearfirm requests
const CLEARFIRM_DESIGNEE = {
  name: 'LaTonya Holmes',
  address: '8465 Houndstooth Enclave Dr',
  city: 'New Port Richey',
  state: 'FL',
  zip: '34655',
  ptin: '0316-30210',
  caf: '0315-23541R',
};

const TEMPLATE_INDIVIDUAL = 'a34ce6060750406fc9464d1d46bf99e053c1c177';
const TEMPLATE_BUSINESS = '6e08048317bb0efd8cf976c2cc14159ca51ef584';

function getTemplateId(formType: string): string {
  if (formType === '1040') return TEMPLATE_INDIVIDUAL;
  return TEMPLATE_BUSINESS;
}

export async function GET(request: NextRequest) {
  try {
    // Validate CRON_SECRET
    const cronSecret = request.headers.get('Authorization');
    const expectedSecret = process.env.CRON_SECRET;

    if (!cronSecret || !expectedSecret || cronSecret !== `Bearer ${expectedSecret}`) {
      return NextResponse.json(
        { error: 'Unauthorized: Invalid CRON_SECRET' },
        { status: 401 }
      );
    }

    const supabase = createAdminClient();

    // Find Clearfirm client
    const { data: clearfirmClient } = await supabase
      .from('clients')
      .select('id')
      .eq('slug', 'clearfirm')
      .single() as { data: { id: string } | null; error: any };

    if (!clearfirmClient) {
      return NextResponse.json({
        success: true,
        processed: 0,
        message: 'Clearfirm client not found',
      });
    }

    // Find Clearfirm requests (API intake) with entities that need 8821 processing
    const { data: requests } = await supabase
      .from('requests')
      .select('id, loan_number, request_entities(id, entity_name, tid, tid_kind, form_type, status, signed_8821_url, signer_email, signer_first_name, signer_last_name, signature_id, address, city, state, zip_code)')
      .eq('client_id', clearfirmClient.id)
      .eq('intake_method', 'api') as { data: any[] | null; error: any };

    if (!requests || requests.length === 0) {
      return NextResponse.json({
        success: true,
        processed: 0,
        message: 'No Clearfirm API requests found',
        processedAt: new Date().toISOString(),
      });
    }

    // Collect entities that need 8821 sent:
    // - Status is submitted, irs_queue, or 8821_sent but has no signature_id yet
    // - No signed_8821_url (hasn't been signed yet)
    // - No signature_id (8821 hasn't been sent yet)
    const pendingEntities: any[] = [];

    for (const req of requests) {
      for (const entity of (req.request_entities || [])) {
        if (
          !entity.signature_id &&
          !entity.signed_8821_url &&
          ['submitted', 'irs_queue', '8821_signed'].includes(entity.status)
        ) {
          pendingEntities.push({
            ...entity,
            request_id: req.id,
            loan_number: req.loan_number,
          });
        }
      }
    }

    if (pendingEntities.length === 0) {
      return NextResponse.json({
        success: true,
        processed: 0,
        message: 'No pending Clearfirm entities need 8821',
        processedAt: new Date().toISOString(),
      });
    }

    // Process each entity — send 8821 via Dropbox Sign
    const api = new DropboxSign.SignatureRequestApi();
    api.username = process.env.DROPBOX_SIGN_API_KEY || '';

    let processed = 0;
    const errors: { entityId: string; entityName: string; error: string }[] = [];

    for (const entity of pendingEntities) {
      try {
        const templateId = getTemplateId(entity.form_type || '1040');

        const signerEmail = entity.signer_email || 'pending-signer@moderntax.io';
        const signerName = [entity.signer_first_name, entity.signer_last_name]
          .filter(Boolean)
          .join(' ') || entity.entity_name;

        // Build taxpayer address from entity data
        const isIndividual = (entity.form_type || '1040') === '1040';
        const entityAddress = [entity.address, entity.city, entity.state, entity.zip_code]
          .filter(Boolean)
          .join(', ') || '';
        const designeeFullAddress = `${CLEARFIRM_DESIGNEE.name}\n${CLEARFIRM_DESIGNEE.address}, ${CLEARFIRM_DESIGNEE.city}, ${CLEARFIRM_DESIGNEE.state} ${CLEARFIRM_DESIGNEE.zip}`;

        // Build custom fields: taxpayer info (Section 1) + designee info (Section 2)
        // Field names differ between individual (1040) and business templates
        // PTIN field on business template is too narrow (27px) — include in designee address block
        const customFields = isIndividual
          ? [
              // Section 1: Taxpayer
              { name: 'Taxpayer Name', value: entity.entity_name || '' },
              { name: 'EIN/SSN Number', value: entity.tid || '' },
              { name: 'Address, City, State, Zip', value: entityAddress },
              // Section 2: Designee
              { name: 'Tax Practioner', value: CLEARFIRM_DESIGNEE.name },
              { name: 'Tax Practioner City, State, Zip Code', value: `${CLEARFIRM_DESIGNEE.address}, ${CLEARFIRM_DESIGNEE.city}, ${CLEARFIRM_DESIGNEE.state} ${CLEARFIRM_DESIGNEE.zip}` },
              { name: 'CAF Number', value: CLEARFIRM_DESIGNEE.caf },
            ]
          : [
              // Section 1: Taxpayer
              { name: 'Taxpayer Name', value: entity.entity_name || '' },
              { name: 'EIN/SSN', value: entity.tid || '' },
              { name: 'Business Address, City, State, Zip Code', value: entityAddress },
              // Section 2: Designee
              { name: 'Designee Name, Address, City State Zip', value: `${designeeFullAddress}\nPTIN: ${CLEARFIRM_DESIGNEE.ptin}` },
              { name: 'CAF', value: CLEARFIRM_DESIGNEE.caf },
            ];

        const signatureData: DropboxSign.SignatureRequestSendWithTemplateRequest = {
          testMode: true, // Remove when upgraded to paid Dropbox Sign API plan
          templateIds: [templateId],
          signers: [
            {
              role: 'Taxpayer',
              name: signerName,
              emailAddress: signerEmail,
            },
          ],
          ccs: [
            {
              role: 'Credit Analyst',
              emailAddress: 'matt@moderntax.io',
            },
          ],
          subject: `Form 8821 — Tax Information Authorization for ${entity.entity_name}`,
          message: `IRS Form 8821 for ${entity.entity_name}. Please print your name on the "Print Name" line as the authorized signer, add your title, then sign and date. Designee: ${CLEARFIRM_DESIGNEE.name} (PTIN: ${CLEARFIRM_DESIGNEE.ptin}, CAF: ${CLEARFIRM_DESIGNEE.caf}). Processed by ModernTax for Clearfirm.`,
          metadata: {
            entity_id: entity.id,
            entity_name: entity.entity_name,
            form_type: entity.form_type,
            client: 'clearfirm',
            designee_name: CLEARFIRM_DESIGNEE.name,
            designee_ptin: CLEARFIRM_DESIGNEE.ptin,
            designee_caf: CLEARFIRM_DESIGNEE.caf,
            loan_number: entity.loan_number,
          },
          customFields,
        };

        const result = await api.signatureRequestSendWithTemplate(signatureData);
        const signatureRequestId = result.body?.signatureRequest?.signatureRequestId;

        if (signatureRequestId) {
          // Update entity with signature info and advance status
          await supabase
            .from('request_entities')
            .update({
              signature_id: signatureRequestId,
              status: '8821_sent',
            })
            .eq('id', entity.id);

          processed++;
          console.log(`[clearfirm-8821] Sent 8821 for ${entity.entity_name} (${signatureRequestId})`);
        } else {
          errors.push({
            entityId: entity.id,
            entityName: entity.entity_name,
            error: 'No signature request ID returned',
          });
        }

        // Rate limit: small delay between requests to avoid Dropbox Sign throttling
        if (pendingEntities.indexOf(entity) < pendingEntities.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[clearfirm-8821] Error for ${entity.entity_name}:`, errorMsg);
        errors.push({
          entityId: entity.id,
          entityName: entity.entity_name,
          error: errorMsg,
        });
      }
    }

    // Notify admin if any entities were processed
    if (processed > 0) {
      const successfulEntities = pendingEntities
        .filter((e: any) => !errors.find((err) => err.entityId === e.id))
        .map((e: any) => ({
          entityName: e.entity_name,
          formType: e.form_type || '1040',
          loanNumber: e.loan_number || 'N/A',
          signatureRequestId: e.signature_id || 'pending',
        }));

      // Fetch the signature IDs that were just set
      const { data: updatedEntities } = await supabase
        .from('request_entities')
        .select('id, entity_name, form_type, signature_id, request_id')
        .in('id', successfulEntities.map((e: any) => pendingEntities.find((p: any) => p.entity_name === e.entityName)?.id).filter(Boolean)) as { data: any[] | null; error: any };

      const notifyEntities = (updatedEntities || []).map((e: any) => {
        const pending = pendingEntities.find((p: any) => p.id === e.id);
        return {
          entityName: e.entity_name,
          formType: e.form_type || '1040',
          loanNumber: pending?.loan_number || 'N/A',
          signatureRequestId: e.signature_id || 'unknown',
        };
      });

      try {
        await sendClearfirmBotNotification(
          'matt@moderntax.io',
          notifyEntities,
          CLEARFIRM_DESIGNEE.name
        );
        console.log(`[clearfirm-8821] Admin notification sent for ${processed} entities`);
      } catch (notifErr) {
        console.error('[clearfirm-8821] Failed to send admin notification:', notifErr);
      }
    }

    return NextResponse.json({
      success: true,
      processed,
      pending: pendingEntities.length,
      errors: errors.length > 0 ? errors : undefined,
      designee: CLEARFIRM_DESIGNEE.name,
      processedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Clearfirm 8821 cron error:', error);
    return NextResponse.json(
      { error: 'Cron job failed', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    );
  }
}
