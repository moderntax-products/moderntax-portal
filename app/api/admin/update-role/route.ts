/**
 * Update User Role API
 * PATCH /api/admin/update-role — Admin or Manager updates a user's role
 *
 * Rules:
 * - Admin can change any user's role (processor <-> manager, or set expert)
 * - Manager can promote/demote within their own client (processor <-> manager only)
 * - Cannot change own role
 * - Cannot set role to 'admin' (only admins are admins)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';

export async function PATCH(request: NextRequest) {
  try {
    const supabase = await createServerComponentClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: callerProfile } = await supabase
      .from('profiles')
      .select('role, client_id')
      .eq('id', user.id)
      .single() as { data: { role: string; client_id: string | null } | null; error: any };

    if (!callerProfile || !['admin', 'manager'].includes(callerProfile.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const { userId, newRole } = body;

    if (!userId || !newRole) {
      return NextResponse.json({ error: 'userId and newRole are required' }, { status: 400 });
    }

    // Cannot change own role
    if (userId === user.id) {
      return NextResponse.json({ error: 'Cannot change your own role' }, { status: 400 });
    }

    const admin = createAdminClient();

    // Get target user
    const { data: targetProfile } = await admin
      .from('profiles')
      .select('id, email, full_name, role, client_id')
      .eq('id', userId)
      .single() as { data: { id: string; email: string; full_name: string | null; role: string; client_id: string | null } | null; error: any };

    if (!targetProfile) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Role validation
    if (callerProfile.role === 'manager') {
      // Managers can only change roles within their own client
      if (targetProfile.client_id !== callerProfile.client_id) {
        return NextResponse.json({ error: 'Cannot change roles for users outside your organization' }, { status: 403 });
      }
      // Managers can only set processor or manager
      if (!['processor', 'manager'].includes(newRole)) {
        return NextResponse.json({ error: 'Managers can only assign processor or manager roles' }, { status: 403 });
      }
      // Managers cannot demote other managers (only admin can)
      if (targetProfile.role === 'manager' && newRole !== 'manager') {
        return NextResponse.json({ error: 'Only admins can demote managers' }, { status: 403 });
      }
    }

    if (callerProfile.role === 'admin') {
      // Admins can set processor, manager, or expert — not admin
      if (!['processor', 'manager', 'expert'].includes(newRole)) {
        return NextResponse.json({ error: 'Invalid role. Must be processor, manager, or expert.' }, { status: 400 });
      }
    }

    // Same role — no-op
    if (targetProfile.role === newRole) {
      return NextResponse.json({ success: true, message: 'Role unchanged', role: newRole });
    }

    // Update role
    const { error: updateError } = await admin
      .from('profiles')
      .update({ role: newRole })
      .eq('id', userId);

    if (updateError) {
      return NextResponse.json({ error: 'Failed to update role', details: updateError.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      userId,
      previousRole: targetProfile.role,
      newRole,
      email: targetProfile.email,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: 'Internal server error', details: msg }, { status: 500 });
  }
}
