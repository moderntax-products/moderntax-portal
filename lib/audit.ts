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
  | 'fax_sent'
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
  | 'invite_resent'
  | 'transcript_request_received'
  | '8821_data_uploaded'
  | 'webhook_delivered'
  | 'webhook_failed'
  | 'irs_rejected_auto_fax_email'
  | 'expert_assignment_cancelled'
  | 'clearfirm_bot_processed'
  | 'irs_call_initiated'
  | 'irs_call_completed'
  | 'irs_call_failed'
  | 'irs_call_cancelled'
  | 'irs_credentials_updated'
  | 'irs_credentials_deleted'
  | 'entity_metadata_updated'
  | 'partner_8821_pdf_uploaded'
  | 'partner_monitoring_enrolled'
  | 'transcript_result_retrieved'
  | 'check_reissue_requested'
  | 'check_reissue_status_changed'
  | '8821_sent_for_signature_by_admin';

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
    const { error: insertErr } = await supabase.from('audit_log').insert({
      organization_id: userId || null,
      user_email: userEmail || null,
      action: event.action,
      entity_type: event.resourceType || null,
      entity_id: event.resourceId || null,
      details: event.details || {},
      ip_address: event.ipAddress || null,
      user_agent: event.userAgent || null,
    });
    if (insertErr) {
      // SOC 2 CC7.2 / CC7.3 — audit insert failures must be loud enough
      // to alert on. Previously the failure only landed in Vercel runtime
      // logs (ephemeral). The `[AUDIT-LOG-FAILURE]` prefix is what the
      // external SIEM alert rule will key on (track item in audit M2).
      console.error('[AUDIT-LOG-FAILURE]', JSON.stringify({
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        userId: userId || null,
        error: insertErr.message,
        timestamp: new Date().toISOString(),
      }));
    }
  } catch (err) {
    // Audit logging should never break the application — but flag with
    // the same SIEM-keyable prefix so unexpected throws also alert.
    console.error('[AUDIT-LOG-FAILURE]', JSON.stringify({
      action: event.action,
      error: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    }));
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
