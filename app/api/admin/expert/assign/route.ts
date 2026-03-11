import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { sendExpertAssignmentNotification } from '@/lib/sendgrid';

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

    // Verify the expert exists and has expert role
    const { data: expertProfile } = await adminSupabase
      .from('profiles')
      .select('id, role, email, full_name')
      .eq('id', expertId)
      .single();

    if (!expertProfile || expertProfile.role !== 'expert') {
      return NextResponse.json({ error: 'Invalid expert' }, { status: 400 });
    }

    // Verify all entities exist and have signed 8821s
    const { data: entities } = await adminSupabase
      .from('request_entities')
      .select('id, entity_name, signed_8821_url, request_id')
      .in('id', entityIds);

    if (!entities || entities.length !== entityIds.length) {
      return NextResponse.json(
        { error: 'Some entities were not found' },
        { status: 400 }
      );
    }

    const withoutForm = entities.filter((e) => !e.signed_8821_url);
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
    });
  } catch (error) {
    console.error('Expert assign error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
