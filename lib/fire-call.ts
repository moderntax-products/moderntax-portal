/**
 * fireScheduledCall — single source of truth for transitioning a session
 * from `scheduled` → live (initiating → ringing) via the voice-provider
 * router.
 *
 * Two callers:
 *   1. /api/cron/irs-call-scheduler — sweeps every few hours, fires anything
 *      where scheduled_for <= now AND status='scheduled'.
 *   2. /api/expert/irs-call/initiate — when an expert schedules a call
 *      within 5 minutes of "now", we fire it INLINE rather than waiting for
 *      the next cron tick. This closes the cron-cadence gap (was up to 3h on
 *      Vercel Hobby, even on Pro is up to 60s with a 1-min cron).
 *
 * Idempotent: bails early if the session isn't in `scheduled` status anymore
 * (cron + inline-fire racing for the same session is safe — first writer wins).
 *
 * Returns the provider call_id + a short status string. Throws on any
 * unrecoverable error; caller is responsible for marking the session
 * failed and logging.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { initiateCall } from './voice-provider';

export interface FireResult {
  call_id: string;
  provider: 'retell' | 'bland';
  status: string;
  from_number?: string;
}

export interface FireOpts {
  /**
   * Admin override — force the call to route from a specific TZ pool
   * entry. 'ET' / 'CT' / 'MT' / 'PT' or full IANA name. Used by the
   * admin "Fire PPS call" UI when the default picker's pick is dead.
   */
  forceFromTz?: string | null;
}

export async function fireScheduledCall(
  supabase: SupabaseClient,
  sessionId: string,
  opts: FireOpts = {},
): Promise<FireResult> {
  const now = new Date();

  // Atomic lock-acquire: flip 'scheduled' → 'initiating' in a single update
  // that ALSO returns the row. If another caller (cron) won the race, our
  // update affects 0 rows and we throw — caller sees the early exit.
  const { data: locked, error: lockErr } = await (supabase
    .from('irs_call_sessions' as any) as any)
    .update({ status: 'initiating', initiated_at: now.toISOString() })
    .eq('id', sessionId)
    .eq('status', 'scheduled')
    .select()
    .maybeSingle();

  if (lockErr) throw new Error(`Lock acquire failed: ${lockErr.message}`);
  if (!locked) {
    // Another caller already picked it up, or the session is in an
    // unexpected state. Nothing to do — return early.
    throw new Error(`Session ${sessionId} not in 'scheduled' state — race condition or invalid call.`);
  }

  // Fetch entities + expert profile
  const { data: callEntities } = await supabase
    .from('irs_call_entities' as any)
    .select('*, request_entities(id, entity_name, tid, tid_kind, form_type, years)')
    .eq('call_session_id', sessionId) as { data: any[]; error: any };
  if (!callEntities || callEntities.length === 0) {
    await rollbackToFailed(supabase, sessionId, 'No call entities attached to session');
    throw new Error('no_entities');
  }

  const { data: expertProfile } = await (supabase
    .from('profiles') as any)
    .select('id, full_name, caf_number, phone_number, fax_number, address')
    .eq('id', locked.expert_id)
    .single();
  if (!expertProfile) {
    await rollbackToFailed(supabase, sessionId, 'Expert profile not found');
    throw new Error('expert_not_found');
  }

  const callMode = locked.callback_mode === 'irs_callback' ? 'irs_callback'
    : locked.callback_mode === 'transfer' ? 'hold_and_transfer'
    : (locked.callback_phone ? 'hold_and_transfer' : 'ai_full');
  let callbackPhone = locked.callback_phone || expertProfile.phone_number || undefined;

  // Autonomous-callback path: hand the agent an AI-answerable pool number so IRS
  // texts/calls a number WE answer (not the expert's phone). Graceful — if the
  // pool isn't provisioned/migrated or the expert is at the 5-callback cap,
  // assignCallbackNumber returns null and we fall back to the expert's phone
  // (legacy behavior), so this can't break live calling.
  let assignedCallbackNumberId: string | null = null;
  if (callMode === 'irs_callback') {
    try {
      const { assignCallbackNumber } = await import('./callback-numbers');
      const assigned = await assignCallbackNumber(supabase as any, locked.expert_id, sessionId);
      if (assigned) { callbackPhone = assigned.phoneNumber; assignedCallbackNumberId = assigned.numberId; }
    } catch (e) { console.warn('[fire-call] callback number assign failed (using expert phone):', e instanceof Error ? e.message : e); }
  }

  let callResponse;
  try {
    callResponse = await initiateCall({
      expertName: locked.expert_name || expertProfile.full_name,
      cafNumber: locked.caf_number || expertProfile.caf_number,
      expertFax: locked.expert_fax || expertProfile.fax_number || undefined,
      expertPhone: expertProfile.phone_number || undefined,
      expertAddress: expertProfile.address || undefined,
      callMode,
      callbackPhone,
      entities: callEntities.map((ce: any) => ({
        entityId: ce.entity_id,
        taxpayerName: ce.taxpayer_name,
        taxpayerTid: ce.taxpayer_tid,
        tidKind: (ce.request_entities?.tid_kind || 'EIN') as 'SSN' | 'EIN',
        formType: ce.form_type,
        years: ce.tax_years,
      })),
      metadata: {
        sessionId: locked.id,
        expertId: locked.expert_id,
        assignmentIds: callEntities.map((ce: any) => ce.assignment_id),
      },
      forceFromTz: opts.forceFromTz || null,
    });
  } catch (err) {
    // Free the assigned callback number — this attempt never reached IRS.
    if (assignedCallbackNumberId) {
      try { const { releaseCallbackNumber } = await import('./callback-numbers'); await releaseCallbackNumber(supabase as any, sessionId); } catch { /* best-effort */ }
    }
    await rollbackToFailed(supabase, sessionId, err instanceof Error ? err.message : 'Provider call failed');
    throw err;
  }

  // Persist provider call_id + flip to ringing
  await (supabase.from('irs_call_sessions' as any) as any)
    .update({
      bland_call_id: callResponse.call_id,
      status: 'ringing',
      from_number: callResponse.from_number || null,
    })
    .eq('id', sessionId);

  // Transition assignments to in_progress
  for (const ce of callEntities) {
    await (supabase.from('expert_assignments') as any)
      .update({ status: 'in_progress' })
      .eq('id', ce.assignment_id)
      .eq('status', 'assigned');
  }

  return {
    call_id: callResponse.call_id,
    provider: callResponse.provider,
    status: callResponse.status,
    from_number: callResponse.from_number,
  };
}

async function rollbackToFailed(supabase: SupabaseClient, sessionId: string, reason: string) {
  await (supabase.from('irs_call_sessions' as any) as any)
    .update({
      status: 'failed',
      ended_at: new Date().toISOString(),
      error_message: reason,
    })
    .eq('id', sessionId);
}

/**
 * Threshold below which a freshly-scheduled call should fire inline
 * (rather than wait for the next cron sweep). Anything > 5 min in the
 * future falls back to the cron, which is fine since the cron sweep
 * lag at that horizon is much smaller than the wait itself.
 */
export const INLINE_FIRE_THRESHOLD_MS = 5 * 60 * 1000;
