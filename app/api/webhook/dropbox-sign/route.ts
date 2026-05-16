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
      // SOC 2 CC6.1 / CC7.2 — return 401 on invalid signature (audit H1).
      // Previously returned 200, which (a) prevented Dropbox Sign from
      // retrying legitimate-but-corrupted events and (b) hid signature-
      // verification failures from any monitoring. The 200/Hello-API
      // response body is reserved for the GET URL-validation handshake.
      console.error('[dropbox-sign] Invalid event hash — rejecting with 401');
      return new NextResponse('Invalid signature', { status: 401 });
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
    // Check both 8821_sent AND pending (for manually-sent 8821s outside portal)
    if (!entity && signatureRequest.signatures?.length) {
      const signerEmails = signatureRequest.signatures
        .map((s: any) => s.signer_email_address)
        .filter(Boolean);

      if (signerEmails.length > 0) {
        const { data: emailEntities } = await supabase
          .from('request_entities')
          .select('id, entity_name, request_id, status')
          .in('signer_email', signerEmails)
          .in('status', ['8821_sent', 'pending', 'submitted'])
          .is('signed_8821_url', null);

        if (emailEntities && emailEntities.length === 1) {
          entity = emailEntities[0];
          console.log(`[dropbox-sign] Matched by signer email: ${entity.entity_name}`);
        } else if (emailEntities && emailEntities.length > 1) {
          const subject = signatureRequest.subject || signatureRequest.title || '';
          const match = emailEntities.find((e: any) =>
            subject.toLowerCase().includes(e.entity_name.toLowerCase())
          );
          if (match) {
            entity = match;
            console.log(`[dropbox-sign] Matched by signer email + subject: ${entity.entity_name}`);
          } else {
            entity = emailEntities[0];
            console.log(`[dropbox-sign] Multiple email matches, using first: ${entity.entity_name}`);
          }
        }
      }
    }

    // Strategy 4: Match by entity name extracted from signature request title
    // Handles manually-sent 8821s where entity has no signature_id or signer_email
    // Title format: "8821 Consent Form Request - ENTITY NAME"
    if (!entity) {
      const title = signatureRequest.title || signatureRequest.subject || '';
      const entityName = title.replace(/^8821 Consent Form Request\s*-\s*/i, '').trim();

      if (entityName && entityName !== title) {
        // Name was actually extracted (title had the expected prefix)
        const { data: nameEntities } = await supabase
          .from('request_entities')
          .select('id, entity_name, request_id, status')
          .is('signed_8821_url', null)
          .not('status', 'in', '("completed","failed")');

        if (nameEntities) {
          // Case-insensitive match
          const match = nameEntities.find(
            (e: any) => e.entity_name.toLowerCase().trim() === entityName.toLowerCase()
          );
          if (match) {
            entity = match;
            console.log(`[dropbox-sign] Matched by entity name in title: ${entity.entity_name}`);
          }
        }
      }

      // Also try matching signer name from signatures against entity name
      if (!entity && signatureRequest.signatures?.length) {
        const signerNames = signatureRequest.signatures
          .map((s: any) => s.signer_name?.toLowerCase().trim())
          .filter(Boolean);

        if (signerNames.length > 0) {
          const { data: allPending } = await supabase
            .from('request_entities')
            .select('id, entity_name, request_id, status')
            .is('signed_8821_url', null)
            .not('status', 'in', '("completed","failed")');

          if (allPending) {
            const match = allPending.find((e: any) =>
              signerNames.includes(e.entity_name.toLowerCase().trim())
            );
            if (match) {
              entity = match;
              console.log(`[dropbox-sign] Matched by signer name: ${entity.entity_name}`);
            }
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
  signatureRequest: any
) {
  // Helper: write a failure marker so /api/admin/reconcile-signatures can find
  // signatures that completed at Dropbox Sign but whose PDFs never landed on
  // our storage. Before this, failures were only console-logged — invisible
  // once the container recycled.
  const markPending = async (stage: 'download' | 'upload', err: unknown) => {
    try {
      await supabase.from('audit_log').insert({
        user_email: '',
        action: 'webhook_failed',
        entity_type: 'request_entity',
        entity_id: entity.id,
        details: {
          source: 'dropbox_sign',
          stage,
          signature_id: signatureRequestId,
          request_id: entity.request_id,
          error: err instanceof Error ? err.message : String(err),
          needs_reconcile: true,
          created_at: new Date().toISOString(),
        },
      });
    } catch (auditErr) {
      console.error(`[dropbox-sign] Could not write failure marker:`, auditErr);
    }
    // Also stamp signature_id on the entity so the reconcile endpoint can find
    // the row even if the failure marker insert itself failed. This is the key
    // signal used by the reconcile sweep.
    try {
      await supabase
        .from('request_entities')
        .update({ signature_id: signatureRequestId })
        .eq('id', entity.id)
        .is('signed_8821_url', null);
    } catch { /* best effort */ }
  };

  // Download signed PDF
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await downloadSignedPdf(signatureRequestId);
  } catch (dlError) {
    console.error(`[dropbox-sign] Failed to download PDF for ${signatureRequestId}:`, dlError);
    await markPending('download', dlError);
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
    await markPending('upload', uploadError);
    return;
  }

  // Update entity — backfill signer identity fields if missing. 14 production
  // rows previously ended up with signed_8821_url set but signer_first_name,
  // signer_last_name, and signature_id all null because this block only wrote
  // signer_email. Now we pull the full signer block from Dropbox Sign's payload.
  const oldStatus = entity.status;
  const signerPayload = signatureRequest?.signatures?.[0] || {};
  const signerEmail = signerPayload.signer_email_address || null;
  const signerFullName: string | null = signerPayload.signer_name || null;
  const [parsedFirstName, ...parsedRestName] = (signerFullName || '').trim().split(/\s+/);
  const signerFirstName = parsedFirstName || null;
  const signerLastName = parsedRestName.length ? parsedRestName.join(' ') : null;
  // Prefer the platform-reported signed-at timestamp if present so the row
  // reflects when the taxpayer actually signed, not when our webhook ran.
  const signedAtIso = signerPayload.signed_at
    ? new Date(signerPayload.signed_at * 1000).toISOString()
    : new Date().toISOString();

  const updateData: Record<string, any> = {
    signed_8821_url: storagePath,
    status: '8821_signed',
    signature_id: signatureRequestId,
    signature_created_at: signedAtIso,
  };
  if (signerEmail) updateData.signer_email = signerEmail;
  if (signerFirstName) updateData.signer_first_name = signerFirstName;
  if (signerLastName) updateData.signer_last_name = signerLastName;

  const { error: updateError } = await supabase
    .from('request_entities')
    .update(updateData)
    .eq('id', entity.id);

  if (updateError) {
    console.error(`[dropbox-sign] Failed to update entity:`, updateError);
    return;
  }

  console.log(`[dropbox-sign] Entity ${entity.id} (${entity.entity_name}) → 8821_signed (signer: ${signerFullName || signerEmail || 'unknown'})`);

  // ─────────────────────────────────────────────────────────────────
  // EXPERT SLA CLOCK START (Phase 1)
  //
  // Per matt 2026-04-27 directive: the expert's SLA clock should start
  // only when the 8821 is signed AND verified to carry that expert's
  // specific credentials (CAF, name, address, PTIN, phone).
  //
  // Phase 1 (now): close approximation — start the clock at signed_at
  // for any active assignment on this entity. Since 8821s are generated
  // via lib/8821-pdf.ts using the assigned expert's designee preset
  // (DESIGNEES.parker / DESIGNEES.default), the expert's creds ARE on
  // the signed PDF in the typical case. The exception is manually-sent
  // 8821s that bypass our generator.
  //
  // Phase 2 (backlog): a verification bot will read the signed PDF,
  // OCR/parse the appointee section, and confirm the creds match the
  // assigned expert before stamping expert_clock_started_at. Until then,
  // we accept the small precision loss in exchange for the clock
  // working at all (vs. blocking every assignment's clock indefinitely).
  // ─────────────────────────────────────────────────────────────────
  try {
    const { error: clockErr } = await supabase
      .from('expert_assignments')
      .update({ expert_clock_started_at: signedAtIso })
      .eq('entity_id', entity.id)
      .in('status', ['assigned', 'in_progress'])
      .is('expert_clock_started_at', null); // only set if not already running
    if (clockErr) {
      console.warn(`[dropbox-sign] Failed to set expert_clock_started_at for entity ${entity.id}:`, clockErr);
    }
  } catch (clockErr) {
    // Column may not exist yet (pre-migration). Don't block the webhook.
    console.warn(`[dropbox-sign] expert_clock_started_at update skipped:`, clockErr);
  }

  // Audit log — every signature event gets a row so forensics aren't reliant on
  // the entity column alone. Historically this handler wrote zero audit rows
  // even on success, making it impossible to reconstruct who signed when.
  try {
    await supabase.from('audit_log').insert({
      user_email: signerEmail || '',
      action: 'file_uploaded',
      entity_type: 'request_entity',
      entity_id: entity.id,
      details: {
        action: '8821_signed_via_dropbox_sign',
        signature_id: signatureRequestId,
        signer_name: signerFullName,
        signer_email: signerEmail,
        signed_at: signedAtIso,
        storage_path: storagePath,
        request_id: entity.request_id,
        prior_status: oldStatus,
      },
    });
  } catch (auditErr) {
    // Audit failure must not block the signed-status update — just log it.
    console.error(`[dropbox-sign] Audit log insert failed:`, auditErr);
  }

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
        .in('status', ['pending', 'submitted', '8821_sent']);
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
