/**
 * Dropbox Sign Webhook
 * POST /api/webhook/dropbox-sign — Receives signature events from Dropbox Sign
 * GET /api/webhook/dropbox-sign — URL validation endpoint (returns required response)
 *
 * When 8821 is fully signed:
 * 1. Downloads signed PDF from Dropbox Sign
 * 2. Uploads to Supabase storage
 * 3. Updates entity status to 8821_signed
 * 4. Notifies processor
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { downloadSignedPdf, validateEventHash } from '@/lib/dropbox-sign';
import { sendStatusChangeNotification } from '@/lib/sendgrid';

// Dropbox Sign requires this exact response for URL validation
export async function GET() {
  return new NextResponse('Hello API Event Received', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}

export async function POST(request: NextRequest) {
  try {
    // Dropbox Sign sends events as multipart/form-data with a "json" field
    const formData = await request.formData();
    const jsonStr = formData.get('json');

    if (!jsonStr || typeof jsonStr !== 'string') {
      console.error('[dropbox-sign] No json field in form data');
      return new NextResponse('Hello API Event Received', { status: 200 });
    }

    const payload = JSON.parse(jsonStr);
    const event = payload.event;

    if (!event) {
      console.error('[dropbox-sign] No event in payload');
      return new NextResponse('Hello API Event Received', { status: 200 });
    }

    // Validate event hash
    const isValid = validateEventHash(
      event.event_type,
      event.event_time,
      event.event_hash
    );

    if (!isValid) {
      console.error('[dropbox-sign] Invalid event hash');
      return new NextResponse('Hello API Event Received', { status: 200 });
    }

    console.log(`[dropbox-sign] Received event: ${event.event_type}`);

    // Only process signature_request_all_signed
    if (event.event_type !== 'signature_request_all_signed') {
      return new NextResponse('Hello API Event Received', { status: 200 });
    }

    const signatureRequest = payload.signature_request;
    if (!signatureRequest) {
      console.error('[dropbox-sign] No signature_request in payload');
      return new NextResponse('Hello API Event Received', { status: 200 });
    }

    const signatureRequestId = signatureRequest.signature_request_id;
    console.log(`[dropbox-sign] Processing signed 8821: ${signatureRequestId}`);

    const supabase = createAdminClient();

    // Try multiple strategies to match the entity
    let entity: { id: string; entity_name: string; request_id: string; status: string } | null = null;

    // Strategy 1: Look up by signature_id
    const { data: sigEntity } = await supabase
      .from('request_entities')
      .select('id, entity_name, request_id, status')
      .eq('signature_id', signatureRequestId)
      .single();

    if (sigEntity) {
      entity = sigEntity;
      console.log(`[dropbox-sign] Matched by signature_id: ${entity.entity_name}`);
    }

    // Strategy 2: Try metadata entity_id
    if (!entity) {
      const metadataEntityId = signatureRequest.metadata?.entity_id;
      if (metadataEntityId) {
        const { data: metaEntity } = await supabase
          .from('request_entities')
          .select('id, entity_name, request_id, status')
          .eq('id', metadataEntityId)
          .single();
        if (metaEntity) {
          entity = metaEntity;
          console.log(`[dropbox-sign] Matched by metadata entity_id: ${entity.entity_name}`);
        }
      }
    }

    // Strategy 3: Match by signer email from the signature request
    if (!entity && signatureRequest.signatures?.length) {
      const signerEmails = signatureRequest.signatures
        .map((s: any) => s.signer_email_address)
        .filter(Boolean);

      if (signerEmails.length > 0) {
        // Find entities in 8821_sent status with matching signer email
        const { data: emailEntities } = await supabase
          .from('request_entities')
          .select('id, entity_name, request_id, status')
          .in('signer_email', signerEmails)
          .eq('status', '8821_sent')
          .is('signed_8821_url', null);

        if (emailEntities && emailEntities.length === 1) {
          entity = emailEntities[0];
          console.log(`[dropbox-sign] Matched by signer email: ${entity.entity_name}`);
        } else if (emailEntities && emailEntities.length > 1) {
          // Multiple matches — try to narrow by entity name in subject
          const subject = signatureRequest.subject || signatureRequest.title || '';
          const match = emailEntities.find((e: any) =>
            subject.toLowerCase().includes(e.entity_name.toLowerCase())
          );
          if (match) {
            entity = match;
            console.log(`[dropbox-sign] Matched by signer email + subject: ${entity.entity_name}`);
          } else {
            // Take the first one as best guess
            entity = emailEntities[0];
            console.log(`[dropbox-sign] Multiple email matches, using first: ${entity.entity_name}`);
          }
        }
      }
    }

    if (!entity) {
      console.error(`[dropbox-sign] No entity found for signature_request_id: ${signatureRequestId}`);
      return new NextResponse('Hello API Event Received', { status: 200 });
    }

    await processSignedEntity(supabase, entity, signatureRequestId, signatureRequest);

    return new NextResponse('Hello API Event Received', { status: 200 });
  } catch (error) {
    console.error('[dropbox-sign] Webhook error:', error);
    // Always return 200 to prevent Dropbox Sign from retrying
    return new NextResponse('Hello API Event Received', { status: 200 });
  }
}

async function processSignedEntity(
  supabase: any,
  entity: { id: string; entity_name: string; request_id: string; status: string },
  signatureRequestId: string,
  _signatureRequest: any
) {
  // Download signed PDF
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await downloadSignedPdf(signatureRequestId);
  } catch (dlError) {
    console.error(`[dropbox-sign] Failed to download PDF for ${signatureRequestId}:`, dlError);
    return;
  }

  // Upload to Supabase storage
  const timestamp = Date.now();
  const storagePath = `8821/${entity.id}/${timestamp}-signed-8821.pdf`;

  const { error: uploadError } = await supabase.storage
    .from('uploads')
    .upload(storagePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (uploadError) {
    console.error(`[dropbox-sign] Failed to upload PDF:`, uploadError);
    return;
  }

  // Update entity — also backfill signature_id if missing
  const oldStatus = entity.status;
  const { error: updateError } = await supabase
    .from('request_entities')
    .update({
      signed_8821_url: storagePath,
      status: '8821_signed',
      signature_id: signatureRequestId,
      signature_created_at: new Date().toISOString(),
    })
    .eq('id', entity.id);

  if (updateError) {
    console.error(`[dropbox-sign] Failed to update entity:`, updateError);
    return;
  }

  console.log(`[dropbox-sign] Entity ${entity.id} (${entity.entity_name}) → 8821_signed`);

  // Check if all entities in the request are at least 8821_signed, update request status
  const { data: allEntities } = await supabase
    .from('request_entities')
    .select('status')
    .eq('request_id', entity.request_id);

  if (allEntities) {
    const statusOrder: Record<string, number> = {
      pending: 0, submitted: 1, '8821_sent': 2, '8821_signed': 3,
      irs_queue: 4, processing: 5, completed: 6, failed: -1,
    };

    const minStatus = allEntities
      .filter((e: any) => e.status !== 'failed')
      .reduce((min: string, e: any) => {
        return (statusOrder[e.status] || 0) < (statusOrder[min] || 0) ? e.status : min;
      }, 'completed');

    if (statusOrder[minStatus] >= statusOrder['8821_signed']) {
      await supabase
        .from('requests')
        .update({ status: '8821_signed' })
        .eq('id', entity.request_id)
        .in('status', ['submitted', '8821_sent']);
    }
  }

  // Notify processor
  try {
    const { data: req } = await supabase
      .from('requests')
      .select('requested_by, loan_number')
      .eq('id', entity.request_id)
      .single();

    if (req) {
      const { data: processor } = await supabase
        .from('profiles')
        .select('email, full_name')
        .eq('id', req.requested_by)
        .single();

      if (processor) {
        await sendStatusChangeNotification(
          processor.email,
          processor.full_name || processor.email,
          entity.entity_name,
          req.loan_number,
          oldStatus,
          '8821_signed'
        );
      }
    }
  } catch (notifError) {
    console.error('[dropbox-sign] Failed to send notification:', notifError);
  }
}
