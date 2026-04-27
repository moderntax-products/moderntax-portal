/**
 * Mark the current user's onboarding tour as completed (or dismissed).
 *
 * POST /api/expert/mark-onboarded
 *   Body: { mode: "completed" | "dismissed" }
 *
 * Sets profiles.onboarding_completed_at OR onboarding_dismissed_at to
 * the current timestamp. Both flags hide the dashboard "Take the tour"
 * banner; tour stays accessible via the Help link in nav regardless.
 *
 * Auth: any logged-in user (managers + processors both go through the
 * same tour — they each see role-specific sections).
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const mode: string = body.mode || 'completed';
  if (!['completed', 'dismissed'].includes(mode)) {
    return NextResponse.json({ error: 'mode must be "completed" or "dismissed"' }, { status: 400 });
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();
  const update = mode === 'completed'
    ? { onboarding_completed_at: now }
    : { onboarding_dismissed_at: now };

  const { error } = await (admin.from('profiles' as any) as any)
    .update(update)
    .eq('id', user.id);

  if (error) {
    return NextResponse.json({ error: 'Failed to update onboarding state', details: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, mode, timestamp: now });
}
