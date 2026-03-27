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
      .select('role')
      .eq('id', user.id)
      .single();

    if (!callerProfile || callerProfile.role !== 'admin') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const body = await request.json();
    const { userId } = body;

    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // Get the target user's profile
    const { data: targetProfile } = await adminSupabase
      .from('profiles')
      .select('id, email, full_name, role, client_id')
      .eq('id', userId)
      .single();

    if (!targetProfile) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Generate a new temp password
    const tempPassword = generateTempPassword();

    // Update the user's password via admin API
    const { error: updateError } = await adminSupabase.auth.admin.updateUserById(userId, {
      password: tempPassword,
    });

    if (updateError) {
      console.error('Failed to reset password:', updateError);
      return NextResponse.json({ error: 'Failed to reset password' }, { status: 500 });
    }

    // Get client name for the email
    let clientName: string | undefined;
    if (targetProfile.client_id) {
      const { data: client } = await adminSupabase
        .from('clients')
        .select('name')
        .eq('id', targetProfile.client_id)
        .single();
      clientName = client?.name;
    }

    // Generate a password reset link
    let resetLink: string | undefined;
    try {
      const { data: linkData } = await adminSupabase.auth.admin.generateLink({
        type: 'recovery',
        email: targetProfile.email,
        options: { redirectTo: `${process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io'}/reset-password` },
      });
      if (linkData?.properties?.hashed_token) {
        const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://nixzwnfjglojemozlvmf.supabase.co';
        resetLink = `${baseUrl}/auth/v1/verify?token=${linkData.properties.hashed_token}&type=recovery&redirect_to=${encodeURIComponent(`${process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io'}/reset-password`)}`;
      }
    } catch (linkErr) {
      console.error('Failed to generate reset link:', linkErr);
    }

    // Send welcome email with reset link (temp password as fallback)
    await sendWelcomeEmail(
      targetProfile.email,
      targetProfile.full_name || targetProfile.email,
      targetProfile.role,
      tempPassword,
      clientName,
      resetLink
    );

    // Audit log
    await logAuditFromRequest(adminSupabase, request, {
      action: 'invite_resent',
      userId: user.id,
      userEmail: user.email || '',
      resourceType: 'profile',
      resourceId: userId,
      details: {
        action: 'resend_invite',
        target_email: targetProfile.email,
        target_role: targetProfile.role,
      },
    });

    return NextResponse.json({
      success: true,
      email: targetProfile.email,
    });
  } catch (error) {
    console.error('Resend invite error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const special = '!@#$%&*';
  let password = '';
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  password += special.charAt(Math.floor(Math.random() * special.length));
  password += Math.floor(Math.random() * 10);
  return password;
}
