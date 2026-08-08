import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { sendExpertAssignmentNotification } from '@/lib/sendgrid';
import { validateExpertDesigneeCreds } from '@/lib/8821-pdf';
import { regenerateEntities8821 } from '@/lib/assignment-batch';

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

    const { data: callerProfile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!callerProfile || callerProfile.role !== 'admin') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const body = await request.json();
    const { entityIds, expertId } = body;

    if (!entityIds || !Array.isArray(entityIds) || entityIds.length === 0) {
      return NextResponse.json({ error: 'entityIds array is required' }, { status: 400 });
    }

    if (!expertId) {
      return NextResponse.json({ error: 'expertId is required' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // Verify the expert exists and has expert role + complete IRS designee creds.
    // Caught 2026-05-16: Joel Abernathy was assigned 4 entities with
    // caf_number=null/ptin=null/phone_number=null on his profile. The 8821s
    // generated for those assignments listed someone else (LaTonya/Matt) as
    // the IRS designee — invalid for Joel to use on a PPS call.
    const { data: expertProfile } = await adminSupabase
      .from('profiles')
      .select('id, role, email, full_name, caf_number, ptin, phone_number, fax_number, address, city, state, zip_code')
      .eq('id', expertId)
      .single() as { data: any };

    if (!expertProfile || expertProfile.role !== 'expert') {
      return NextResponse.json({ error: 'Invalid expert' }, { status: 400 });
    }

    const missingCreds = validateExpertDesigneeCreds(expertProfile);
    if (missingCreds.length > 0) {
      return NextResponse.json(
        {
          error: `Cannot assign — ${expertProfile.full_name || expertProfile.email}'s profile is missing required IRS designee fields: ${missingCreds.join(', ')}. They must complete /expert/profile before receiving assignments.`,
          missing_fields: missingCreds,
          expert_email: expertProfile.email,
        },
        { status: 400 },
      );
    }

    // Verify all entities exist and have signed 8821s. Select the full set of
    // designee-regeneration fields too, so we can re-issue the 8821 under this
    // expert's CAF right here (below) instead of leaving a stale designee for
    // an admin to fix with the manual Regenerate button.
    const { data: entities } = await adminSupabase
      .from('request_entities')
      .select('id, entity_name, signed_8821_url, request_id, form_type, tid, address, city, state, zip_code, years, signer_first_name, signer_last_name, gross_receipts')
      .in('id', entityIds);

    if (!entities || entities.length !== entityIds.length) {
      return NextResponse.json(
        { error: 'Some entities were not found' },
        { status: 400 }
      );
    }

    // All entities need a signed 8821 before expert assignment
    // Exception: W2_INCOME (employment verification) entities don't require 8821
    const withoutForm = entities.filter((e) => !e.signed_8821_url && e.form_type !== 'W2_INCOME');
    if (withoutForm.length > 0) {
      return NextResponse.json(
        {
          error: `Entities missing signed 8821: ${withoutForm.map((e) => e.entity_name).join(', ')}`,
        },
        { status: 400 }
      );
    }

    // Check for existing active assignments on these entities
    const { data: existingAssignments } = await adminSupabase
      .from('expert_assignments')
      .select('entity_id, status')
      .in('entity_id', entityIds)
      .in('status', ['assigned', 'in_progress']);

    if (existingAssignments && existingAssignments.length > 0) {
      // Mark existing active assignments as reassigned
      await adminSupabase
        .from('expert_assignments')
        .update({ status: 'reassigned' })
        .in('entity_id', existingAssignments.map((a) => a.entity_id))
        .in('status', ['assigned', 'in_progress']);
    }

    // Create new assignments
    const assignments = entityIds.map((entityId: string) => ({
      entity_id: entityId,
      expert_id: expertId,
      assigned_by: user.id,
    }));

    const { data: newAssignments, error: assignError } = await adminSupabase
      .from('expert_assignments')
      .insert(assignments)
      .select();

    if (assignError) {
      console.error('Assignment creation error:', assignError);
      return NextResponse.json({ error: 'Failed to create assignments' }, { status: 500 });
    }

    // Update entity statuses to irs_queue
    await adminSupabase
      .from('request_entities')
      .update({ status: 'irs_queue' })
      .in('id', entityIds);

    // Regenerate each 8821 under THIS expert's designee credentials — the same
    // step acceptBatch runs automatically. Without this, a direct (re)assignment
    // left the previous/generic designee on the form and relied on an admin
    // remembering to click "Regenerate 8821 w/ expert creds" (a wrong CAF on the
    // form = a failed IRS PPS call). Best-effort: assignment already succeeded,
    // so per-entity regen failures are reported, not fatal.
    const { regenerated, errors: regenErrors } = await regenerateEntities8821(
      adminSupabase,
      expertProfile,
      entities,
    );
    if (regenErrors.length > 0) {
      console.error(`[expert/assign] 8821 regen failed for ${regenErrors.length}/${entities.length} entities:`, regenErrors);
    }

    // Audit log
    await logAuditFromRequest(adminSupabase, request, {
      action: 'expert_assigned',
      userId: user.id,
      userEmail: user.email || '',
      resourceType: 'expert_assignment',
      resourceId: expertId,
      details: {
        expert_email: expertProfile.email,
        expert_name: expertProfile.full_name,
        entity_count: entityIds.length,
        entity_ids: entityIds,
      },
    });

    // Send email notification to expert
    try {
      const entityNames = entities.map((e) => e.entity_name);
      await sendExpertAssignmentNotification(
        expertProfile.email,
        entityNames,
        entityIds.length
      );
    } catch (emailError) {
      console.error('Failed to send expert assignment email:', emailError);
      // Don't fail the assignment if email fails
    }

    return NextResponse.json({
      success: true,
      assignments: newAssignments,
      assigned_count: entityIds.length,
      regenerated_8821_count: regenerated.length,
      regen_errors: regenErrors.length > 0 ? regenErrors : undefined,
    });
  } catch (error) {
    console.error('Expert assign error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
