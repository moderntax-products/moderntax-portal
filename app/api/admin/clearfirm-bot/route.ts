/**
 * Clearfirm Bot API
 * GET: List pending Clearfirm entities awaiting 8821 processing
 * POST: Process entities — generate filled 8821 PDF and send via Dropbox Sign
 *
 * v2: Uses file-based signature requests with server-side PDF generation
 *     instead of Dropbox Sign templates. All Section 3 tax info, designee
 *     PTIN/CAF/phone, and taxpayer details are filled in the PDF form fields.
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { generate8821PDF, DESIGNEES as PDF_DESIGNEES } from '@/lib/8821-pdf';
import type { DesigneeInfo } from '@/lib/8821-pdf';
import * as DropboxSign from '@dropbox/sign';
import { Readable } from 'stream';

// Map legacy designee keys to the new standardized format in 8821-pdf.ts
function getDesigneeForEntity(entity: any): DesigneeInfo {
  const key = entity.designee_key || entity.designee_override || 'default';
  return PDF_DESIGNEES[key] || PDF_DESIGNEES.default;
}

function getDropboxApi(): DropboxSign.SignatureRequestApi {
  const api = new DropboxSign.SignatureRequestApi();
  api.username = process.env.DROPBOX_SIGN_API_KEY || '';
  return api;
}

/** Convert a Buffer to a ReadStream for the Dropbox Sign SDK */
function bufferToStream(buffer: Buffer, filename: string): any {
  const stream = Readable.from(buffer) as any;
  stream.path = filename;         // SDK needs .path to detect filename
  stream.name = filename;         // Some SDK versions use .name
  return stream;
}

/**
 * GET: Fetch all pending Clearfirm entities that need 8821 processing
 */
export async function GET(_request: Request) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single() as { data: { role: string } | null; error: any };

    if (!profile || profile.role !== 'admin') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const adminSupabase = createAdminClient();

    // Find the Clearfirm client
    const { data: clearfirmClient } = await adminSupabase
      .from('clients')
      .select('id, name, slug')
      .eq('slug', 'clearfirm')
      .single() as { data: { id: string; name: string; slug: string } | null; error: any };

    if (!clearfirmClient) {
      return NextResponse.json({ error: 'Clearfirm client not found' }, { status: 404 });
    }

    // Find all Clearfirm requests with their entities
    const { data: requests } = await adminSupabase
      .from('requests')
      .select('id, loan_number, status, intake_method, created_at, request_entities(id, entity_name, tid, tid_kind, form_type, status, signed_8821_url, signer_email, signer_first_name, signer_last_name, address, city, state, zip_code, signature_id)')
      .eq('client_id', clearfirmClient.id)
      .order('created_at', { ascending: false }) as { data: any[] | null; error: any };

    // Categorize entities
    const pendingEntities: any[] = [];
    const processingEntities: any[] = [];
    const completedEntities: any[] = [];

    (requests || []).forEach((req: any) => {
      (req.request_entities || []).forEach((entity: any) => {
        const enriched = {
          ...entity,
          request_id: req.id,
          loan_number: req.loan_number,
          intake_method: req.intake_method,
          request_created_at: req.created_at,
        };

        if (['submitted', '8821_sent', 'irs_queue'].includes(entity.status) && !entity.signed_8821_url) {
          pendingEntities.push(enriched);
        } else if (['irs_queue', 'processing', '8821_signed'].includes(entity.status) && entity.signed_8821_url) {
          processingEntities.push(enriched);
        } else if (entity.status === 'completed') {
          completedEntities.push(enriched);
        }
      });
    });

    return NextResponse.json({
      designee: PDF_DESIGNEES.default,
      pending: pendingEntities,
      processing: processingEntities,
      completed: completedEntities,
      totalRequests: (requests || []).length,
    });
  } catch (error) {
    console.error('Clearfirm bot GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST: Process entity — send 8821 via Dropbox Sign for offline download
 * Body: { entityIds: string[], action: 'send_8821' | 'mark_sent' }
 */
export async function POST(request: Request) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single() as { data: { role: string } | null; error: any };

    if (!profile || profile.role !== 'admin') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const body = await request.json();
    const { entityIds, action } = body;

    if (!entityIds || !Array.isArray(entityIds) || entityIds.length === 0) {
      return NextResponse.json({ error: 'entityIds array required' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // Fetch entities
    const { data: entities, error: fetchError } = await adminSupabase
      .from('request_entities')
      .select('id, entity_name, tid, tid_kind, form_type, status, signer_email, signer_first_name, signer_last_name, address, city, state, zip_code, request_id')
      .in('id', entityIds) as { data: any[] | null; error: any };

    if (fetchError || !entities || entities.length === 0) {
      return NextResponse.json({ error: 'Entities not found' }, { status: 404 });
    }

    const results: any[] = [];

    if (action === 'send_8821') {
      // Send 8821 signature requests via Dropbox Sign with filled PDFs
      const api = getDropboxApi();

      for (const entity of entities) {
        try {
          const designee = getDesigneeForEntity(entity);
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

          // Send as file-based signature request (not template)
          const sigRequest = new DropboxSign.SignatureRequestSendRequest();
          // testMode removed — production signatures are now legally binding
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
          };
          // Signature field at Section 6 signature line (coordinates from IRS form)
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
            await adminSupabase
              .from('request_entities')
              .update({
                signature_id: signatureRequestId,
                status: '8821_sent',
              })
              .eq('id', entity.id);

            results.push({
              entityId: entity.id,
              entityName: entity.entity_name,
              status: 'sent',
              signatureRequestId,
            });
          } else {
            results.push({
              entityId: entity.id,
              entityName: entity.entity_name,
              status: 'error',
              error: 'No signature request ID returned',
            });
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error';
          console.error(`[clearfirm-bot] Error sending 8821 for ${entity.entity_name}:`, errorMsg);
          results.push({
            entityId: entity.id,
            entityName: entity.entity_name,
            status: 'error',
            error: errorMsg,
          });
        }

        // Rate limit: 1 second between Dropbox Sign API calls
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } else if (action === 'download_template') {
      // Generate pre-filled 8821 PDFs for offline signature
      for (const entity of entities) {
        try {
          const designee = getDesigneeForEntity(entity);
          const formType = (entity.form_type || '1040') as '1040' | '1065' | '1120' | '1120S';
          const entityAddress = [entity.address, entity.city, entity.state, entity.zip_code]
            .filter(Boolean)
            .join(', ') || '';

          const pdfBuffer = await generate8821PDF({
            taxpayer: {
              name: entity.entity_name || '',
              tin: entity.tid || '',
              address: entityAddress,
            },
            designee,
            formType,
          });

          // Upload to Supabase storage for download
          const storagePath = `8821-templates/clearfirm/${entity.id}/${Date.now()}-8821-template.pdf`;
          const { error: uploadError } = await adminSupabase.storage
            .from('transcripts')
            .upload(storagePath, pdfBuffer, {
              contentType: 'application/pdf',
              upsert: true,
            });

          if (uploadError) {
            throw new Error(`Upload failed: ${uploadError.message}`);
          }

          results.push({
            entityId: entity.id,
            entityName: entity.entity_name,
            status: 'template_ready',
            storagePath,
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error';
          results.push({
            entityId: entity.id,
            entityName: entity.entity_name,
            status: 'error',
            error: errorMsg,
          });
        }
      }
    }

    // Audit log
    await logAuditFromRequest(adminSupabase, request, {
      action: 'clearfirm_bot_processed',
      userId: user.id,
      userEmail: user.email || '',
      resourceType: 'clearfirm_bot',
      resourceId: entityIds.join(','),
      details: {
        action,
        entity_count: entityIds.length,
        designee: PDF_DESIGNEES.default.name,
        results,
      },
    });

    return NextResponse.json({
      success: true,
      action,
      results,
      designee: PDF_DESIGNEES.default,
    });
  } catch (error) {
    console.error('Clearfirm bot POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
