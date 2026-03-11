/**
 * Analytics Event Tracking API
 *
 * POST /api/analytics/track
 *
 * Receives page views and client-side events from the browser.
 * Uses admin client to insert events (bypasses RLS).
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { trackEvent } from '@/lib/analytics';
import type { EventType } from '@/lib/analytics';

const VALID_EVENT_TYPES: EventType[] = [
  'page_view',
  'session_start',
  'feature_used',
];

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { type, path, referrer, sessionId, metadata } = body;

    // Validate event type — only allow safe client-side events
    if (!type || !VALID_EVENT_TYPES.includes(type)) {
      return NextResponse.json(
        { error: 'Invalid event type' },
        { status: 400 }
      );
    }

    // Get user context from session (if logged in)
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);
    const adminClient = createAdminClient();

    let userId: string | undefined;
    let userEmail: string | undefined;
    let userRole: string | undefined;
    let clientId: string | undefined;

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      userId = user.id;
      userEmail = user.email;

      const { data: profile } = await supabase
        .from('profiles')
        .select('role, client_id')
        .eq('id', user.id)
        .single();

      userRole = profile?.role || undefined;
      clientId = profile?.client_id || undefined;
    }

    // Track the event using admin client (bypasses RLS)
    await trackEvent(adminClient, {
      type,
      userId,
      userEmail,
      userRole,
      clientId,
      path: path || undefined,
      referrer: referrer || undefined,
      sessionId: sessionId || undefined,
      metadata: metadata || {},
      ipAddress:
        request.headers.get('x-forwarded-for') ||
        request.headers.get('x-real-ip') ||
        undefined,
      userAgent: request.headers.get('user-agent') || undefined,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[analytics] Track error:', err);
    // Never fail the request — analytics is non-critical
    return NextResponse.json({ ok: true });
  }
}
