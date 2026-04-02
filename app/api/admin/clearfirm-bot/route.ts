/**
 * Clearfirm Bot API
 * GET: List pending Clearfirm entities awaiting 8821 processing
 * POST: Process entities — generate 8821 via Dropbox Sign with LaTonya Holmes designee,
 *       download signed template for offline signature, update entity status
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import * as DropboxSign from '@dropbox/sign';

// Designee profiles
const DESIGNEES: Record<string, {
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  ptin: string;
  caf: string;
}> = {
  default: {
    name: 'LaTonya Holmes',
    address: '8465 Houndstooth Enclave Dr',
    city: 'New Port Richey',
    state: 'FL',
    zip: '34655',
    ptin: '0316-30210',
    caf: '0315-23541R',
  },
  parker: {
    name: 'Matthew Parker C/O ModernTax',
    address: '2 Embarcadero, 8th Floor',
    city: 'San Francisco',
    state: 'CA',
    zip: '94111',
    ptin: 'P01809554',
    caf: '0316-30210R',
  },
};

// Default designee for backward compat
const CLEARFIRM_DESIGNEE = DESIGNEES.default;

// Template IDs (same as dropbox-sign.ts)
const TEMPLATE_INDIVIDUAL = 'a34ce6060750406fc9464d1d46bf99e053c1c177';
const TEMPLATE_BUSINESS = '6e08048317bb0efd8cf976c2cc14159ca51ef584';

function getTemplateId(formType: string): string {
  if (formType === '1040') return TEMPLATE_INDIVIDUAL;
  return TEMPLATE_BUSINESS;
}

function getDropboxApi(): DropboxSign.SignatureRequestApi {
  const api = new DropboxSign.SignatureRequestApi();
  api.username = process.env.DROPBOX_SIGN_API_KEY || '';
  return api;
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
      designee: CLEARFIRM_DESIGNEE,
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
      // Send 8821 signature requests via Dropbox Sign
      const api = getDropboxApi();

      for (const entity of entities) {
        try {
          const templateId = getTemplateId(entity.form_type || '1040');

          // Use signer email or a placeholder for offline processing
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
            message: `IRS Form 8821 for ${entity.entity_name}. Designee: ${CLEARFIRM_DESIGNEE.name} (PTIN: ${CLEARFIRM_DESIGNEE.ptin}, CAF: ${CLEARFIRM_DESIGNEE.caf}). Processed by ModernTax for Clearfirm.`,
            metadata: {
              entity_id: entity.id,
              entity_name: entity.entity_name,
              form_type: entity.form_type,
              client: 'clearfirm',
              designee_name: CLEARFIRM_DESIGNEE.name,
              designee_ptin: CLEARFIRM_DESIGNEE.ptin,
              designee_caf: CLEARFIRM_DESIGNEE.caf,
            },
            customFields,
          };

          const result = await api.signatureRequestSendWithTemplate(signatureData);
          const signatureRequestId = result.body?.signatureRequest?.signatureRequestId;

          if (signatureRequestId) {
            // Update entity with signature info
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
      }
    } else if (action === 'download_template') {
      // Download pre-filled 8821 templates for offline signature
      for (const entity of entities) {
        try {
          const templateId = getTemplateId(entity.form_type || '1040');

          // Download template PDF for offline signature
          const templateApi = new DropboxSign.TemplateApi();
          templateApi.username = process.env.DROPBOX_SIGN_API_KEY || '';

          // Get template files for download
          const filesResult = await templateApi.templateFiles(templateId, 'pdf');
          const pdfBuffer = filesResult.body;

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
        designee: CLEARFIRM_DESIGNEE.name,
        results,
      },
    });

    return NextResponse.json({
      success: true,
      action,
      results,
      designee: CLEARFIRM_DESIGNEE,
    });
  } catch (error) {
    console.error('Clearfirm bot POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
