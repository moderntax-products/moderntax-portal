/**
 * Clearfirm 8821 Auto-Processing Cron
 * Runs daily — automatically sends 8821 signature requests
 * for all new Clearfirm API entities that don't have one yet.
 *
 * v2: Uses file-based signature requests with server-side PDF generation.
 *     All Section 3 tax info, designee PTIN/CAF/phone, and taxpayer details
 *     are filled in the PDF form fields before sending via Dropbox Sign.
 *
 * GET /api/cron/clearfirm-8821
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendClearfirmBotNotification } from '@/lib/sendgrid';
import { generate8821PDF, DESIGNEES } from '@/lib/8821-pdf';
import type { DesigneeInfo } from '@/lib/8821-pdf';
import * as DropboxSign from '@dropbox/sign';
import { Readable } from 'stream';

function getDesignee(entity: any): DesigneeInfo {
  if (entity.designee_key && DESIGNEES[entity.designee_key]) {
    return DESIGNEES[entity.designee_key];
  }
  return DESIGNEES.default;
}

function bufferToStream(buffer: Buffer, filename: string): any {
  const stream = Readable.from(buffer) as any;
  stream.path = filename;
  stream.name = filename;
  return stream;
}

export const maxDuration = 60;

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

    // Collect entities that need 8821 sent
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
        const designee = getDesignee(entity);
        const formType = (entity.form_type || '1040') as '1040' | '1065' | '1120' | '1120S';
        const signerEmail = entity.signer_email || 'pending-signer@moderntax.io';
        const signerName = [entity.signer_first_name, entity.signer_last_name]
          .filter(Boolean)
          .join(' ') || entity.entity_name;
        const entityAddress = [entity.address, entity.city, entity.state, entity.zip_code]
          .filter(Boolean)
          .join(', ') || '';

        // Generate filled 8821 PDF with all sections populated
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
          client: 'clearfirm',
          designee_name: designee.name,
          designee_ptin: designee.ptin,
          designee_caf: designee.caf,
          loan_number: entity.loan_number,
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

        const result = await api.signatureRequestSend(sigRequest);
        const signatureRequestId = result.body?.signatureRequest?.signatureRequestId;

        if (signatureRequestId) {
          await supabase
            .from('request_entities')
            .update({
              signature_id: signatureRequestId,
              status: '8821_sent',
            })
            .eq('id', entity.id);

          processed++;
          console.log(`[clearfirm-8821] Sent 8821 for ${entity.entity_name} (${signatureRequestId}) — designee: ${designee.name}`);
        } else {
          errors.push({
            entityId: entity.id,
            entityName: entity.entity_name,
            error: 'No signature request ID returned',
          });
        }

        // Rate limit
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

    // Notify admin
    if (processed > 0) {
      const successfulEntities = pendingEntities
        .filter((e: any) => !errors.find((err) => err.entityId === e.id))
        .map((e: any) => ({
          entityName: e.entity_name,
          formType: e.form_type || '1040',
          loanNumber: e.loan_number || 'N/A',
          signatureRequestId: e.signature_id || 'pending',
        }));

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
          'Multiple Designees'
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
