/**
 * POST /api/admin/approve-signup
 *
 * Admin reviews a pending sign-up and either:
 *   - APPROVES + assigns a client_id (existing or new) + role, fires
 *     welcome email, lifts the auth ban so the user can log in.
 *   - REJECTS with a reason; user is bounced from /login if they try.
 *
 * Body:
 *   {
 *     user_id: string,                 // profiles.id of the pending sign-up
 *     action: 'approve' | 'reject',
 *
 *     // Required when action='approve':
 *     client_id?: string,              // assign to existing client (UUID), OR
 *     new_client?: {                   // create a fresh client first
 *       name: string,
 *       domain: string,
 *       slug?: string,
 *       free_trial?: boolean,
 *     },
 *     role?: 'manager' | 'processor',  // default 'manager'
 *
 *     // Optional for action='reject':
 *     reject_reason?: string,
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { sendSignupApprovedEmail } from '@/lib/sendgrid';

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: callerProfile } = await supabase
    .from('profiles')
    .select('role, email')
    .eq('id', user.id)
    .single() as { data: { role: string; email: string } | null; error: any };

  if (!callerProfile || callerProfile.role !== 'admin') {
    return NextResponse.json({ error: 'Admin-only' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const { user_id: targetUserId, action, client_id, new_client, role, reject_reason } = body;

  if (!targetUserId || typeof targetUserId !== 'string') {
    return NextResponse.json({ error: 'user_id is required' }, { status: 400 });
  }
  if (action !== 'approve' && action !== 'reject') {
    return NextResponse.json({ error: 'action must be "approve" or "reject"' }, { status: 400 });
  }

  const admin = createAdminClient();

  // Confirm the target user is actually pending — don't let admin
  // re-approve already-approved users (would be a no-op but still
  // confusing in audit logs).
  const { data: target } = await (admin.from('profiles' as any) as any)
    .select('id, email, full_name, approval_status')
    .eq('id', targetUserId)
    .single();

  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 });
  if (target.approval_status === 'approved') {
    return NextResponse.json({ error: 'User already approved', detail: `${target.email} is already active.` }, { status: 409 });
  }

  // ─── REJECT path ───
  if (action === 'reject') {
    const { error } = await (admin.from('profiles' as any) as any)
      .update({
        approval_status: 'rejected',
        approval_rejected_reason: (reject_reason || '').trim() || null,
      })
      .eq('id', targetUserId);
    if (error) return NextResponse.json({ error: 'Failed to reject', detail: error.message }, { status: 500 });

    // Best-effort: ban the auth user so they can't issue new sessions
    try {
      await admin.auth.admin.updateUserById(targetUserId, { ban_duration: '876000h' /* 100 yrs */ });
    } catch (banErr) {
      console.warn('[approve-signup] auth ban failed (non-blocking):', banErr);
    }

    await (admin.from('audit_log' as any) as any).insert({
      user_email: callerProfile.email,
      action: 'role_changed',
      entity_type: 'profile',
      entity_id: targetUserId,
      details: { action: 'signup_rejected', reason: reject_reason || null, target_email: target.email },
    });

    return NextResponse.json({ success: true, action: 'rejected', user_id: targetUserId });
  }

  // ─── APPROVE path ───
  if (!client_id && !new_client) {
    return NextResponse.json({
      error: 'Must provide client_id (existing) or new_client (to create)',
    }, { status: 400 });
  }

  let assignedClientId: string;
  let assignedClientName: string;

  if (client_id) {
    const { data: existing } = await admin
      .from('clients')
      .select('id, name')
      .eq('id', client_id)
      .single() as { data: { id: string; name: string } | null; error: any };
    if (!existing) return NextResponse.json({ error: 'client_id not found' }, { status: 404 });
    assignedClientId = existing.id;
    assignedClientName = existing.name;
  } else {
    if (!new_client?.name?.trim() || !new_client?.domain?.trim()) {
      return NextResponse.json({ error: 'new_client requires name + domain' }, { status: 400 });
    }
    const slug = (new_client.slug || generateSlug(new_client.name)).trim();
    const { data: created, error: createErr } = await admin
      .from('clients')
      .insert({
        name: new_client.name.trim(),
        slug,
        domain: new_client.domain.trim().toLowerCase(),
        intake_methods: ['csv', 'pdf', 'manual'],
        free_trial: new_client.free_trial !== false, // default true for new clients
      })
      .select('id, name')
      .single() as { data: { id: string; name: string } | null; error: any };
    if (createErr || !created) {
      return NextResponse.json({ error: 'Failed to create client', detail: createErr?.message }, { status: 500 });
    }
    assignedClientId = created.id;
    assignedClientName = created.name;
  }

  // 'direct_user' = a ModernTax Direct taxpayer — limited to their own case
  // (status, intake, payment, support chat); no team/billing/management.
  const assignedRole = ['processor', 'direct_user'].includes(role) ? role : 'manager';

  // Update profile: assign client + role, mark approved
  const { error: profileErr } = await (admin.from('profiles' as any) as any)
    .update({
      client_id: assignedClientId,
      role: assignedRole,
      approval_status: 'approved',
      approved_at: new Date().toISOString(),
      approved_by: user.id,
    })
    .eq('id', targetUserId);

  if (profileErr) {
    return NextResponse.json({ error: 'Failed to update profile', detail: profileErr.message }, { status: 500 });
  }

  // Lift any auth ban from sign-up time
  try {
    await admin.auth.admin.updateUserById(targetUserId, { ban_duration: 'none' });
  } catch (banErr) {
    console.warn('[approve-signup] auth unban failed (non-blocking):', banErr);
  }

  // Welcome email — non-blocking
  try {
    await sendSignupApprovedEmail(target.email, target.full_name || '', assignedClientName);
  } catch (emailErr) {
    console.error('[approve-signup] welcome email failed:', emailErr);
  }

  await (admin.from('audit_log' as any) as any).insert({
    user_email: callerProfile.email,
    action: 'role_changed',
    entity_type: 'profile',
    entity_id: targetUserId,
    details: {
      action: 'signup_approved',
      target_email: target.email,
      assigned_client_id: assignedClientId,
      assigned_client_name: assignedClientName,
      assigned_role: assignedRole,
    },
  });

  return NextResponse.json({
    success: true,
    action: 'approved',
    user_id: targetUserId,
    client_id: assignedClientId,
    client_name: assignedClientName,
    role: assignedRole,
  });
}
