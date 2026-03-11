import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { sendWelcomeEmail } from '@/lib/sendgrid';

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    // Verify the caller is an admin
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { data: callerProfile } = await supabase
      .from('profiles')
      .select('role, client_id')
      .eq('id', user.id)
      .single();

    if (!callerProfile || !['admin', 'manager'].includes(callerProfile.role)) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const isManager = callerProfile.role === 'manager';

    const body = await request.json();
    const { email, fullName, role, clientId } = body;

    // Validate inputs (experts don't need clientId)
    if (!email || !fullName || !role) {
      return NextResponse.json(
        { error: 'Missing required fields: email, fullName, role' },
        { status: 400 }
      );
    }

    // Internal roles (admin, expert) don't need a clientId
    const isInternalRole = role === 'admin' || role === 'expert';
    if (!isInternalRole && !clientId) {
      return NextResponse.json(
        { error: 'Missing required field: clientId' },
        { status: 400 }
      );
    }

    // Managers can only invite processors, and only to their own client
    if (isManager) {
      if (role !== 'processor') {
        return NextResponse.json(
          { error: 'Managers can only invite processors' },
          { status: 403 }
        );
      }
      if (clientId !== callerProfile.client_id) {
        return NextResponse.json(
          { error: 'Managers can only invite users to their own organization' },
          { status: 403 }
        );
      }
    }

    if (!['processor', 'manager', 'expert', 'admin'].includes(role)) {
      return NextResponse.json(
        { error: 'Role must be processor, manager, expert, or admin' },
        { status: 400 }
      );
    }

    // Use admin client to create the user
    const adminSupabase = createAdminClient();

    // Check if user already exists
    const { data: existingProfiles } = await adminSupabase
      .from('profiles')
      .select('id, email')
      .eq('email', email);

    if (existingProfiles && existingProfiles.length > 0) {
      return NextResponse.json(
        { error: 'A user with this email already exists' },
        { status: 409 }
      );
    }

    // Generate a temporary password (user will need to reset)
    const tempPassword = generateTempPassword();

    // Create auth user via admin API
    const { data: newUser, error: createError } = await adminSupabase.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true, // Auto-confirm email
      user_metadata: {
        full_name: fullName,
        role: role,
      },
    });

    if (createError) {
      console.error('Failed to create user:', createError);
      return NextResponse.json(
        { error: createError.message },
        { status: 500 }
      );
    }

    if (!newUser.user) {
      return NextResponse.json(
        { error: 'Failed to create user - no user returned' },
        { status: 500 }
      );
    }

    // Update the auto-created profile with client_id and role
    // (The trigger creates it with default values, we need to update)
    // Experts don't get a client_id — they work across all clients
    const { error: profileError } = await adminSupabase
      .from('profiles')
      .update({
        full_name: fullName,
        role: role,
        client_id: isInternalRole ? null : clientId,
      })
      .eq('id', newUser.user.id);

    if (profileError) {
      console.error('Failed to update profile:', profileError);
      // Try to clean up the auth user
      await adminSupabase.auth.admin.deleteUser(newUser.user.id);
      return NextResponse.json(
        { error: 'Failed to set up user profile' },
        { status: 500 }
      );
    }

    // Audit log
    await logAuditFromRequest(adminSupabase, request, {
      action: 'entity_created',
      userId: user.id,
      userEmail: user.email || '',
      resourceType: 'profile',
      resourceId: newUser.user.id,
      details: {
        invited_email: email,
        invited_name: fullName,
        invited_role: role,
        client_id: clientId,
      },
    });

    // Send welcome email with temp password
    try {
      let clientName: string | undefined;
      if (!isInternalRole && clientId) {
        const { data: client } = await adminSupabase
          .from('clients')
          .select('name')
          .eq('id', clientId)
          .single();
        clientName = client?.name;
      }
      await sendWelcomeEmail(email, fullName, role, tempPassword, clientName);
    } catch (emailError) {
      console.error('Failed to send welcome email:', emailError);
      // Don't fail the invite if email fails
    }

    return NextResponse.json({
      success: true,
      user: {
        id: newUser.user.id,
        email: email,
        fullName: fullName,
        role: role,
        tempPassword: tempPassword, // Admin can share this securely
      },
    });
  } catch (error) {
    console.error('Invite error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const special = '!@#$%&*';
  let password = '';
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Add a special character and a number to meet common password requirements
  password += special.charAt(Math.floor(Math.random() * special.length));
  password += Math.floor(Math.random() * 10);
  return password;
}
