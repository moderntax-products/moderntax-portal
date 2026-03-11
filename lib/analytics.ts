/**
 * Server-side Analytics Tracking
 *
 * Logs usage events to the analytics_events table for
 * page views, signups, logins, and key actions.
 *
 * Usage:
 *   import { trackEvent } from '@/lib/analytics';
 *   await trackEvent(supabase, { type: 'page_view', path: '/dashboard' });
 */

import { SupabaseClient } from '@supabase/supabase-js';

export type EventType =
  | 'page_view'
  | 'signup'
  | 'login'
  | 'login_failed'
  | 'request_created'
  | 'request_viewed'
  | 'transcript_downloaded'
  | 'file_uploaded'
  | 'expert_assigned'
  | 'expert_completed'
  | 'invite_sent'
  | 'password_reset'
  | 'session_start'
  | 'feature_used';

export type EventCategory =
  | 'navigation'
  | 'auth'
  | 'request'
  | 'transcript'
  | 'admin'
  | 'expert'
  | 'general';

export interface AnalyticsEvent {
  type: EventType;
  category?: EventCategory;
  userId?: string;
  userEmail?: string;
  userRole?: string;
  clientId?: string;
  path?: string;
  referrer?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

// Category mapping for common event types
const EVENT_CATEGORIES: Record<EventType, EventCategory> = {
  page_view: 'navigation',
  signup: 'auth',
  login: 'auth',
  login_failed: 'auth',
  request_created: 'request',
  request_viewed: 'request',
  transcript_downloaded: 'transcript',
  file_uploaded: 'request',
  expert_assigned: 'expert',
  expert_completed: 'expert',
  invite_sent: 'admin',
  password_reset: 'auth',
  session_start: 'auth',
  feature_used: 'general',
};

/**
 * Track an analytics event
 * Uses admin/service client to bypass RLS for inserts
 */
export async function trackEvent(
  supabase: SupabaseClient,
  event: AnalyticsEvent
): Promise<void> {
  try {
    const category = event.category || EVENT_CATEGORIES[event.type] || 'general';

    await supabase.from('analytics_events').insert({
      event_type: event.type,
      event_category: category,
      user_id: event.userId || null,
      user_email: event.userEmail || null,
      user_role: event.userRole || null,
      client_id: event.clientId || null,
      page_path: event.path || null,
      referrer: event.referrer || null,
      session_id: event.sessionId || null,
      metadata: event.metadata || {},
      ip_address: event.ipAddress || null,
      user_agent: event.userAgent || null,
    });
  } catch (err) {
    // Analytics should never break the application
    console.error('[analytics] Failed to track event:', event.type, err);
  }
}

/**
 * Track an event from an API route with request context
 */
export async function trackFromRequest(
  supabase: SupabaseClient,
  request: Request,
  event: Omit<AnalyticsEvent, 'ipAddress' | 'userAgent'>
): Promise<void> {
  return trackEvent(supabase, {
    ...event,
    ipAddress:
      request.headers.get('x-forwarded-for') ||
      request.headers.get('x-real-ip') ||
      undefined,
    userAgent: request.headers.get('user-agent') || undefined,
  });
}

/**
 * Track an event with auto-detected user context from Supabase auth
 */
export async function trackWithUser(
  supabase: SupabaseClient,
  adminClient: SupabaseClient,
  event: Omit<AnalyticsEvent, 'userId' | 'userEmail' | 'userRole' | 'clientId'>
): Promise<void> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return trackEvent(adminClient, event);
    }

    // Get profile for role and client_id
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, client_id')
      .eq('id', user.id)
      .single();

    return trackEvent(adminClient, {
      ...event,
      userId: user.id,
      userEmail: user.email,
      userRole: profile?.role || undefined,
      clientId: profile?.client_id || undefined,
    });
  } catch {
    // Fallback — track without user context
    return trackEvent(adminClient, event);
  }
}
