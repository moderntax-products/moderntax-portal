/**
 * Trial funnel event logger.
 * Fire-and-forget — never throws so it cannot block primary request paths.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type FunnelEventType =
  | 'signup_submitted' | 'signup_approved' | 'signup_rejected' | 'signup_disqualified'
  | 'dashboard_visited' | 'request_submitted' | 'pull_completed' | 'trial_exhausted'
  | 'paywall_seen' | 'card_capture_initiated' | 'card_captured'
  | 'trial_converted' | 'conversion_failed' | 'trial_expired'
  | 'pilot_offered' | 'pilot_purchased' | 'invoice_issued' | 'invoice_paid'
  | 'tier_upgraded' | 'reminder_sent' | 'hot_trial_alerted' | 'review_nudge_sent';

export async function logFunnelEvent(
  admin: SupabaseClient,
  eventType: FunnelEventType,
  clientId: string | null,
  userId: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    const { error } = await (admin.from('trial_funnel_events') as any).insert({
      event_type: eventType,
      client_id: clientId,
      user_id: userId,
      metadata,
    });
    if (error && !/trial_funnel_events|relation .* does not exist|PGRST/i.test(error.message || '')) {
      console.warn('[funnel-events] insert failed:', error.message);
    }
  } catch (err: any) {
    console.warn('[funnel-events] threw:', err?.message || err);
  }
}
