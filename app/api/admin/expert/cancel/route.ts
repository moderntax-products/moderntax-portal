import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';

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
    const { assignmentId } = body;

    if (!assignmentId) {
      return NextResponse.json({ error: 'assignmentId is required' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // Fetch the assignment to verify it exists and is cancellable
    const { data: assignment, error: fetchError } = await adminSupabase
      .from('expert_assignments')
      .select('id, entity_id, expert_id, status, expert_profile:profiles!expert_assignments_expert_id_fkey(full_name, email)')
      .eq('id', assignmentId)
      .single() as { data: any; error: any };

    if (fetchError || !assignment) {
      return NextResponse.json({ error: 'Assignment not found' }, { status: 404 });
    }

    if (!['assigned', 'in_progress'].includes(assignment.status)) {
      return NextResponse.json(
        { error: `Cannot cancel assignment with status "${assignment.status}"` },
        { status: 400 }
      );
    }

    // Cancel the assignment
    const { error: updateError } = await adminSupabase
      .from('expert_assignments')
      .update({
        status: 'cancelled',
        miss_reason: 'admin_cancelled',
        expert_notes: `Cancelled by admin before expert action`,
      })
      .eq('id', assignmentId);

    if (updateError) {
      console.error('Cancel assignment error:', updateError);
      return NextResponse.json({ error: 'Failed to cancel assignment' }, { status: 500 });
    }

    // Reset entity status back to 8821_signed (ready for re-assignment)
    await adminSupabase
      .from('request_entities')
      .update({ status: '8821_signed' })
      .eq('id', assignment.entity_id);

    // Audit log
    await logAuditFromRequest(adminSupabase, request, {
      action: 'expert_assignment_cancelled',
      userId: user.id,
      userEmail: user.email || '',
      resourceType: 'expert_assignment',
      resourceId: assignmentId,
      details: {
        entity_id: assignment.entity_id,
        expert_id: assignment.expert_id,
        expert_name: assignment.expert_profile?.full_name,
        expert_email: assignment.expert_profile?.email,
        previous_status: assignment.status,
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Assignment cancelled',
    });
  } catch (error) {
    console.error('Cancel assignment error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
