/**
 * Forgot Password API Route
 * Generates a password reset link via Supabase Admin API and sends it via SendGrid
 * POST /api/auth/forgot-password
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendPasswordResetEmail } from '@/lib/sendgrid';

export async function POST(request: NextRequest) {
  try {
    const { email } = await request.json();

    if (!email || typeof email !== 'string') {
      return NextResponse.json(
        { error: 'Email is required' },
        { status: 400 }
      );
    }

    const supabase = createAdminClient();

    // Check if user exists in profiles
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, full_name')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (!profile) {
      // Don't reveal whether user exists — always return success
      return NextResponse.json({
        success: true,
        message: 'If an account with that email exists, a password reset link has been sent.',
      });
    }

    // Generate recovery link using Supabase Admin API
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email: email.toLowerCase().trim(),
    });

    if (linkError || !linkData) {
      console.error('Failed to generate recovery link:', linkError);
      return NextResponse.json(
        { error: 'Failed to send reset email. Please try again.' },
        { status: 500 }
      );
    }

    // Extract the hashed token and build a direct reset URL
    // This avoids Supabase's verify redirect which has PKCE/implicit flow issues
    const hashedToken = linkData.properties?.hashed_token;

    if (!hashedToken) {
      console.error('No hashed_token in recovery response');
      return NextResponse.json(
        { error: 'Failed to generate reset link. Please try again.' },
        { status: 500 }
      );
    }

    const resetLink = `${appUrl}/reset-password?token_hash=${encodeURIComponent(hashedToken)}&type=recovery`;

    // Send the reset email via SendGrid
    await sendPasswordResetEmail(
      email.toLowerCase().trim(),
      profile.full_name || 'there',
      resetLink
    );

    return NextResponse.json({
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent.',
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    return NextResponse.json(
      { error: 'An unexpected error occurred. Please try again.' },
      { status: 500 }
    );
  }
}
