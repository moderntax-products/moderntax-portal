/**
 * SOC 2 Audit Logging Utility
 * Logs all security-relevant user actions for compliance
 *
 * Uses the existing `audit_log` table in Supabase.
 * Table schema:
 *   id, user_email, organization_id, action, entity_type, entity_id,
 *   details, ip_address, user_agent, created_at
 *
 * Usage:
 *   await logAuditEvent(supabase, {
 *     action: 'login',
 *     resourceType: 'auth',
 *     details: { method: 'password' },
 *   });
 */

import { SupabaseClient } from '@supabase/supabase-js';

export type AuditAction =
  | 'login'
  | 'logout'
  | 'login_failed'
  | 'session_timeout'
  | 'request_created'
  | 'request_viewed'
  | 'entity_created'
  | 'transcript_downloaded'
  | 'file_uploaded'
  | 'batch_created'
  | 'profile_accessed'
  | 'admin_access'
  | 'data_exported'
  | 'settings_changed'
  | 'expert_assigned'
  | 'expert_completed'
  | 'expert_issue_flagged'
  | 'expert_transcript_uploaded'
  | 'client_created'
  | 'employment_request_received'
  | 'employment_result_retrieved'
  | 'invite_resent';

export interface AuditEvent {
  action: AuditAction;
  userId?: string;
  userEmail?: string;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Log a security-relevant audit event
 * Uses service role client when available, otherwise authenticated client
 */
export async function logAuditEvent(
  supabase: SupabaseClient,
  event: AuditEvent
): Promise<void> {
  try {
    // Get user info if not provided
    let userId = event.userId;
    let userEmail = event.userEmail;

    if (!userId || !userEmail) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      userId = userId || user?.id || undefined;
      userEmail = userEmail || user?.email || undefined;
    }

    // Insert into the existing audit_log table
    // Maps our interface to the table's column names:
    //   resourceType → entity_type
    //   resourceId → entity_id
    //   userId → organization_id (repurposed for user tracking)
    await supabase.from('audit_log').insert({
      organization_id: userId || null,
      user_email: userEmail || null,
      action: event.action,
      entity_type: event.resourceType || null,
      entity_id: event.resourceId || null,
      details: event.details || {},
      ip_address: event.ipAddress || null,
      user_agent: event.userAgent || null,
    });
  } catch (err) {
    // Audit logging should never break the application
    console.error('[audit] Failed to log event:', event.action, err);
  }
}

/**
 * Log an audit event from an API route with request context
 */
export async function logAuditFromRequest(
  supabase: SupabaseClient,
  request: Request,
  event: Omit<AuditEvent, 'ipAddress' | 'userAgent'>
): Promise<void> {
  return logAuditEvent(supabase, {
    ...event,
    ipAddress:
      request.headers.get('x-forwarded-for') ||
      request.headers.get('x-real-ip') ||
      undefined,
    userAgent: request.headers.get('user-agent') || undefined,
  });
}
