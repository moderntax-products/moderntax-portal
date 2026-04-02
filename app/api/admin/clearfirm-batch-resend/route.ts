/**
 * One-time Clearfirm Batch Resend
 * Resets and re-sends 8821s for all Clearfirm entities with split designees:
 *   - First 5 entities (by created_at): Matthew Parker designee, assigned to Matthew Parker expert
 *   - Last 3 entities: LaTonya Holmes designee, assigned to LaTonya Holmes expert
 *
 * POST /api/admin/clearfirm-batch-resend
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import * as DropboxSign from '@dropbox/sign';

const DESIGNEES = {
  parker: {
    name: 'Matthew Parker C/O ModernTax',
    address: '2 Embarcadero, 8th Floor',
    city: 'San Francisco',
    state: 'CA',
    zip: '94111',
    ptin: 'P01809554',
    caf: '0316-30210R',
  },
  holmes: {
    name: 'LaTonya Holmes',
    address: '8465 Houndstooth Enclave Dr',
    city: 'New Port Richey',
    state: 'FL',
    zip: '34655',
    ptin: '0316-30210',
    caf: '0315-23541R',
  },
};

// Expert IDs
const EXPERTS = {
  parker: 'bd374d60-5146-4ca9-90e6-29af28af641f',  // Matthew Parker
  holmes: 'e5534e60-ea77-434c-90b5-605ca8ffcbe2',  // LaTonya Holmes
};

const TEMPLATE_BUSINESS = '6e08048317bb0efd8cf976c2cc14159ca51ef584';
const TEMPLATE_INDIVIDUAL = 'a34ce6060750406fc9464d1d46bf99e053c1c177';

function getTemplateId(formType: string): string {
  if (formType === '1040') return TEMPLATE_INDIVIDUAL;
  return TEMPLATE_BUSINESS;
}

export async function POST(request: NextRequest) {
  try {
    const cronSecret = request.headers.get('Authorization');
    const expectedSecret = process.env.CRON_SECRET;

    if (!cronSecret || !expectedSecret || cronSecret !== `Bearer ${expectedSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabase = createAdminClient();

    // Find Clearfirm client
    const { data: clearfirmClient } = await supabase
      .from('clients')
      .select('id')
      .eq('slug', 'clearfirm')
      .single() as { data: { id: string } | null; error: any };

    if (!clearfirmClient) {
      return NextResponse.json({ error: 'Clearfirm client not found' }, { status: 404 });
    }

    // Fetch all Clearfirm API requests ordered by creation
    const { data: requests } = await supabase
      .from('requests')
      .select('id, loan_number, created_at, request_entities(id, entity_name, tid, tid_kind, form_type, status, signature_id, signer_email, signer_first_name, signer_last_name, address, city, state, zip_code)')
      .eq('client_id', clearfirmClient.id)
      .eq('intake_method', 'api')
      .order('created_at', { ascending: true }) as { data: any[] | null; error: any };

    if (!requests || requests.length === 0) {
      return NextResponse.json({ error: 'No Clearfirm requests found' }, { status: 404 });
    }

    // Flatten entities in order
    const allEntities: any[] = [];
    for (const req of requests) {
      for (const entity of (req.request_entities || [])) {
        allEntities.push({
          ...entity,
          request_id: req.id,
          loan_number: req.loan_number,
        });
      }
    }

    console.log(`[clearfirm-batch] Found ${allEntities.length} entities to process`);

    // Split: first 5 → Parker, last 3 → Holmes
    const parkerEntities = allEntities.slice(0, 5);
    const holmesEntities = allEntities.slice(5);

    // Step 1: Cancel any existing expert assignments for all entities
    const allEntityIds = allEntities.map(e => e.id);
    const { data: existingAssignments } = await supabase
      .from('expert_assignments')
      .select('id, entity_id')
      .in('entity_id', allEntityIds)
      .in('status', ['assigned', 'in_progress']) as { data: any[] | null; error: any };

    if (existingAssignments && existingAssignments.length > 0) {
      await supabase
        .from('expert_assignments')
        .update({ status: 'cancelled', miss_reason: 'batch_resend' })
        .in('id', existingAssignments.map(a => a.id));
      console.log(`[clearfirm-batch] Cancelled ${existingAssignments.length} existing assignments`);
    }

    // Step 2: Reset all entities — clear signature_id, set status to submitted
    await supabase
      .from('request_entities')
      .update({ signature_id: null, status: 'submitted' })
      .in('id', allEntityIds);
    console.log(`[clearfirm-batch] Reset ${allEntityIds.length} entities`);

    // Step 3: Send 8821s with correct designee
    const api = new DropboxSign.SignatureRequestApi();
    api.username = process.env.DROPBOX_SIGN_API_KEY || '';

    const results: any[] = [];

    async function sendAndAssign(
      entity: any,
      designee: typeof DESIGNEES.parker,
      expertId: string,
      expertName: string
    ) {
      const templateId = getTemplateId(entity.form_type || '1040');
      const signerEmail = entity.signer_email || 'pending-signer@moderntax.io';
      const signerName = [entity.signer_first_name, entity.signer_last_name]
        .filter(Boolean)
        .join(' ') || entity.entity_name;

      const isIndividual = (entity.form_type || '1040') === '1040';
      const entityAddress = [entity.address, entity.city, entity.state, entity.zip_code]
        .filter(Boolean)
        .join(', ') || '';
      const designeeFullAddress = `${designee.name}\n${designee.address}, ${designee.city}, ${designee.state} ${designee.zip}`;

      const customFields = isIndividual
        ? [
            { name: 'Taxpayer Name', value: entity.entity_name || '' },
            { name: 'EIN/SSN Number', value: entity.tid || '' },
            { name: 'Address, City, State, Zip', value: entityAddress },
            { name: 'Tax Practioner', value: designee.name },
            { name: 'Tax Practioner City, State, Zip Code', value: `${designee.address}, ${designee.city}, ${designee.state} ${designee.zip}` },
            { name: 'CAF Number', value: designee.caf },
            { name: 'PTIN', value: designee.ptin },
          ]
        : [
            { name: 'Taxpayer Name', value: entity.entity_name || '' },
            { name: 'EIN/SSN', value: entity.tid || '' },
            { name: 'Business Address, City, State, Zip Code', value: entityAddress },
            { name: 'Designee Name, Address, City State Zip', value: `${designeeFullAddress}\nPTIN: ${designee.ptin}` },
            { name: 'CAF', value: designee.caf },
          ];

      const signatureData: DropboxSign.SignatureRequestSendWithTemplateRequest = {
        testMode: true,
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
        message: `IRS Form 8821 for ${entity.entity_name}. Designee: ${designee.name} (PTIN: ${designee.ptin}, CAF: ${designee.caf}). Processed by ModernTax for Clearfirm.`,
        metadata: {
          entity_id: entity.id,
          entity_name: entity.entity_name,
          form_type: entity.form_type,
          client: 'clearfirm',
          designee_name: designee.name,
          designee_ptin: designee.ptin,
          designee_caf: designee.caf,
          loan_number: entity.loan_number,
        },
        customFields,
      };

      const result = await api.signatureRequestSendWithTemplate(signatureData);
      const signatureRequestId = result.body?.signatureRequest?.signatureRequestId;

      if (!signatureRequestId) {
        throw new Error('No signature request ID returned');
      }

      // Update entity
      await supabase
        .from('request_entities')
        .update({
          signature_id: signatureRequestId,
          status: '8821_sent',
        })
        .eq('id', entity.id);

      // Get admin ID for assigned_by
      const { data: adminProfile } = await supabase
        .from('profiles')
        .select('id')
        .eq('role', 'admin')
        .limit(1)
        .single() as { data: { id: string } | null; error: any };

      // Create expert assignment
      const slaDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await supabase
        .from('expert_assignments')
        .insert({
          entity_id: entity.id,
          expert_id: expertId,
          assigned_by: adminProfile?.id || expertId,
          status: 'assigned',
          sla_deadline: slaDeadline,
        });

      // Update entity status to irs_queue (assigned to expert)
      await supabase
        .from('request_entities')
        .update({ status: 'irs_queue' })
        .eq('id', entity.id);

      return {
        entityId: entity.id,
        entityName: entity.entity_name,
        formType: entity.form_type,
        tid: entity.tid,
        signatureRequestId,
        designee: designee.name,
        expert: expertName,
        status: 'success',
      };
    }

    // Process Parker entities (first 5)
    for (const entity of parkerEntities) {
      try {
        const result = await sendAndAssign(entity, DESIGNEES.parker, EXPERTS.parker, 'Matthew Parker');
        results.push(result);
        console.log(`[clearfirm-batch] ✓ ${entity.entity_name} → Parker designee, Parker expert`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[clearfirm-batch] ✗ ${entity.entity_name}: ${errorMsg}`);
        results.push({
          entityId: entity.id,
          entityName: entity.entity_name,
          designee: 'Matthew Parker',
          expert: 'Matthew Parker',
          status: 'error',
          error: errorMsg,
        });
      }
      // Rate limit
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    // Process Holmes entities (last 3)
    for (const entity of holmesEntities) {
      try {
        const result = await sendAndAssign(entity, DESIGNEES.holmes, EXPERTS.holmes, 'LaTonya Holmes');
        results.push(result);
        console.log(`[clearfirm-batch] ✓ ${entity.entity_name} → Holmes designee, Holmes expert`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[clearfirm-batch] ✗ ${entity.entity_name}: ${errorMsg}`);
        results.push({
          entityId: entity.id,
          entityName: entity.entity_name,
          designee: 'LaTonya Holmes',
          expert: 'LaTonya Holmes',
          status: 'error',
          error: errorMsg,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    const successCount = results.filter(r => r.status === 'success').length;
    const errorCount = results.filter(r => r.status === 'error').length;

    return NextResponse.json({
      success: true,
      total: allEntities.length,
      processed: successCount,
      errors: errorCount,
      results,
      splits: {
        parker: { count: parkerEntities.length, entities: parkerEntities.map(e => e.entity_name) },
        holmes: { count: holmesEntities.length, entities: holmesEntities.map(e => e.entity_name) },
      },
    });
  } catch (error) {
    console.error('Clearfirm batch resend error:', error);
    return NextResponse.json(
      { error: 'Batch resend failed', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    );
  }
}
