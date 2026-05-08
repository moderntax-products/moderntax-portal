/**
 * IRS PPS auto-retry coordinator (MOD-211 MVP)
 *
 * When a call ends with a retryable outcome (high_volume_rejected or
 * connection_failed), this module fires a fresh call attempt linked to
 * the original via `parent_session_id`, rotates the from-number across
 * the phone pool, and writes the new session row.
 *
 * Pure orchestration — the call-completion webhook calls this, and the
 * classifier (lib/irs-call-classifier) decides whether to.
 */

import { createAdminClient } from './supabase-server';
import { initiateCall } from './voice-provider';
import {
  classifyCallOutcome,
  isRetryableOutcome,
  isTerminalSuccess,
  type IrsCallOutcome,
} from './irs-call-classifier';

const DEFAULT_MAX_RETRIES = 30;
// MVP: no sleep between attempts. We rotate from-numbers each retry so
// IRS isn't seeing repeated calls from the same caller, and Vercel
// serverless functions can't reliably hold a 60s setTimeout open across
// the webhook ack boundary anyway. Re-introduce a backoff via a cron in
// MOD-211 Phase 2 if rate limiting becomes a problem.
const DEFAULT_BACKOFF_MS = 0;

interface SessionRow {
  id: string;
  expert_id: string;
  parent_session_id: string | null;
  retry_count: number | null;
  max_retries: number | null;
  auto_retry_enabled: boolean | null;
  retry_terminal_state: string | null;
  from_number: string | null;
  status: string | null;
  concatenated_transcript: string | null;
  classified_outcome: string | null;
  caf_number: string | null;
  expert_name: string | null;
  expert_fax: string | null;
  expert_sor_id: string | null;
}

const KNOWN_OUTCOMES: ReadonlySet<IrsCallOutcome> = new Set([
  'high_volume_rejected',
  'wait_too_long_no_callback',
  'callback_scheduled',
  'agent_reached',
  'connection_failed',
  'other',
]);

/**
 * Find the root session id of a retry chain. Walks up the
 * parent_session_id pointers until we hit a node with no parent.
 * Used to gather the full chain when rotating from-numbers and
 * deciding when to mark a terminal_state.
 */
async function rootSessionIdOf(sessionId: string): Promise<string> {
  const admin = createAdminClient();
  let cursor = sessionId;
  // Bounded walk — chains shouldn't exceed max_retries depth
  for (let i = 0; i < DEFAULT_MAX_RETRIES + 1; i++) {
    const { data } = await (admin.from('irs_call_sessions' as any) as any)
      .select('parent_session_id')
      .eq('id', cursor)
      .maybeSingle();
    if (!data?.parent_session_id) return cursor;
    cursor = data.parent_session_id;
  }
  return cursor; // safety: bail out at the cap
}

/**
 * Collect every from-number used in the retry chain rooted at this
 * session, so the picker rotates to a fresh pool slot.
 */
async function fromNumbersInChain(rootId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await (admin.from('irs_call_sessions' as any) as any)
    .select('from_number')
    .or(`id.eq.${rootId},parent_session_id.eq.${rootId}`);
  return (data || [])
    .map((r: any) => r.from_number)
    .filter((n: string | null): n is string => !!n);
}

/**
 * Process a finished call and decide whether to fire a retry.
 *
 * Called from the bland/retell call-completion webhook AFTER the session
 * row has been updated with transcript + status. This function:
 *
 *   1. Classifies the outcome from the transcript.
 *   2. Persists the classification on the session row.
 *   3. If terminal-success → marks the chain's root as done.
 *   4. If retryable AND under cap → fires a new call from a different
 *      from-number, links via parent_session_id.
 *   5. If retry cap hit → marks chain root as 'cap_hit', no retry fires.
 *
 * Returns a summary describing what happened.
 */
export async function handleCompletedCall(sessionId: string): Promise<{
  outcome: IrsCallOutcome;
  action: 'terminal_success' | 'retry_fired' | 'cap_hit' | 'not_retryable' | 'auto_retry_disabled';
  newSessionId?: string;
  chainRootId?: string;
}> {
  const admin = createAdminClient();

  // Load the just-finished session
  const { data: session, error: loadErr } = await (admin
    .from('irs_call_sessions' as any) as any)
    .select('id, expert_id, parent_session_id, retry_count, max_retries, auto_retry_enabled, retry_terminal_state, from_number, status, concatenated_transcript, classified_outcome, caf_number, expert_name, expert_fax, expert_sor_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (loadErr || !session) {
    throw new Error(`[irs-call-retry] session ${sessionId} not found: ${loadErr?.message || 'no row'}`);
  }
  const s = session as SessionRow;

  // Prefer the AI's own mid-call signal (set via notify_status →
  // status-update endpoint) over a transcript heuristic. The AI knows
  // exactly which decision branch it took (e.g. wait_too_long_no_callback)
  // and the transcript may not preserve enough phrasing to re-classify.
  const preset = s.classified_outcome as IrsCallOutcome | null;
  const outcome: IrsCallOutcome = preset && KNOWN_OUTCOMES.has(preset)
    ? preset
    : classifyCallOutcome({
        transcript: s.concatenated_transcript,
        status: s.status,
      });
  await (admin.from('irs_call_sessions' as any) as any)
    .update({ classified_outcome: outcome })
    .eq('id', sessionId);

  const rootId = await rootSessionIdOf(sessionId);

  // Terminal success → mark chain root and stop
  if (isTerminalSuccess(outcome)) {
    await (admin.from('irs_call_sessions' as any) as any)
      .update({ retry_terminal_state: outcome })
      .eq('id', rootId);
    return { outcome, action: 'terminal_success', chainRootId: rootId };
  }

  // Not retryable (e.g., 'other') — admin reviews manually
  if (!isRetryableOutcome(outcome)) {
    return { outcome, action: 'not_retryable', chainRootId: rootId };
  }

  // Auto-retry disabled at the session level (or chain root)
  if (s.auto_retry_enabled === false) {
    return { outcome, action: 'auto_retry_disabled', chainRootId: rootId };
  }

  // Cap check — count attempts in the chain so far
  const currentCount = (s.retry_count || 0);
  const maxRetries = s.max_retries ?? DEFAULT_MAX_RETRIES;
  if (currentCount >= maxRetries) {
    await (admin.from('irs_call_sessions' as any) as any)
      .update({ retry_terminal_state: 'cap_hit' })
      .eq('id', rootId);
    return { outcome, action: 'cap_hit', chainRootId: rootId };
  }

  // Build the retry call. We replay the original entities + expert
  // identity off the parent session's data, mark the new attempt with
  // parent_session_id and incremented retry_count.
  const newSession = await fireRetryAttempt(sessionId, rootId, outcome);
  return { outcome, action: 'retry_fired', newSessionId: newSession?.id, chainRootId: rootId };
}

/**
 * Build and fire a retry attempt linked to the parent session. Returns
 * the newly-inserted session row (or null if something went wrong, in
 * which case the chain stays in flight and the safety-net cron will
 * catch it on the next pass).
 */
async function fireRetryAttempt(
  parentSessionId: string,
  rootId: string,
  reason: IrsCallOutcome,
): Promise<{ id: string } | null> {
  const admin = createAdminClient();

  // Load parent session for caller-identity replay
  const { data: parent } = await (admin.from('irs_call_sessions' as any) as any)
    .select('id, expert_id, retry_count, max_retries, caf_number, expert_name, expert_fax, expert_sor_id')
    .eq('id', parentSessionId)
    .maybeSingle();
  if (!parent) {
    console.error(`[irs-call-retry] parent session ${parentSessionId} vanished mid-retry`);
    return null;
  }

  // Load the per-entity assignments for this chain's call
  const { data: callEntities } = await (admin.from('irs_call_entities' as any) as any)
    .select('assignment_id, entity_id, taxpayer_tid, taxpayer_name, form_type, tax_years')
    .eq('call_session_id', parent.id);
  if (!callEntities || callEntities.length === 0) {
    console.error(`[irs-call-retry] no call_entities for parent ${parent.id} — cannot retry`);
    return null;
  }

  // Load the expert profile fields needed by initiateCall (it pulls
  // SSN/DOB itself; we just need the public-record identity here)
  const { data: profile } = await (admin.from('profiles' as any) as any)
    .select('full_name, caf_number, ptin, phone_number, fax_number, address, city, state, zip_code, sor_id, voice_sample_url')
    .eq('id', parent.expert_id)
    .maybeSingle();
  if (!profile) {
    console.error(`[irs-call-retry] expert profile ${parent.expert_id} not found — cannot retry`);
    return null;
  }

  // Load the request_entities for full taxpayer details
  const entityIds: string[] = (callEntities as any[]).map(c => c.entity_id);
  const { data: entities } = await (admin
    .from('request_entities') as any)
    .select('id, entity_name, tid, tid_kind, form_type, years, address, city, state, zip_code')
    .in('id', entityIds);
  if (!entities || entities.length === 0) {
    console.error(`[irs-call-retry] request_entities not found for retry — entity_ids=${entityIds.join(',')}`);
    return null;
  }

  // Insert the new session row first so we have an id to pass to initiateCall
  const newRetryCount = (parent.retry_count || 0) + 1;
  const { data: newSession, error: insertErr } = await (admin
    .from('irs_call_sessions' as any) as any)
    .insert({
      expert_id: parent.expert_id,
      status: 'initiating',
      caf_number: profile.caf_number,
      expert_name: profile.full_name || '',
      expert_fax: profile.fax_number || null,
      parent_session_id: parent.id,
      retry_count: newRetryCount,
      max_retries: parent.max_retries || DEFAULT_MAX_RETRIES,
      auto_retry_enabled: true,
    })
    .select('id')
    .single();
  if (insertErr || !newSession) {
    console.error('[irs-call-retry] failed to insert retry session:', insertErr?.message);
    return null;
  }

  // Mark the parent with the retry_reason now that we know we're firing
  await (admin.from('irs_call_sessions' as any) as any)
    .update({ retry_reason: reason })
    .eq('id', parent.id);

  // Insert per-entity rows on the new session, mirroring the parent's chain
  await (admin.from('irs_call_entities' as any) as any).insert(
    (callEntities as any[]).map(c => ({
      call_session_id: newSession.id,
      assignment_id: c.assignment_id,
      entity_id: c.entity_id,
      taxpayer_tid: c.taxpayer_tid,
      taxpayer_name: c.taxpayer_name,
      form_type: c.form_type,
      tax_years: c.tax_years,
    })),
  );

  // No-op backoff in MVP (DEFAULT_BACKOFF_MS=0). Kept as an explicit
  // hook so MOD-211 Phase 2 can introduce a cron-based delay without
  // restructuring this function. See note at top of file.
  if (DEFAULT_BACKOFF_MS > 0) {
    await new Promise(resolve => setTimeout(resolve, DEFAULT_BACKOFF_MS));
  }

  // Build the exclusion list — every from-number used in this chain
  const excludeFromNumbers = await fromNumbersInChain(rootId);

  // Fire the new call
  let response;
  try {
    response = await initiateCall({
      expertName: profile.full_name || '',
      cafNumber: profile.caf_number || '',
      expertFax: profile.fax_number || undefined,
      expertPhone: profile.phone_number || undefined,
      expertAddress: profile.address || undefined,
      sorInbox: profile.sor_id || undefined,
      voiceSampleUrl: profile.voice_sample_url || undefined,
      entities: (entities as any[]).map(e => ({
        entityId: e.id,
        taxpayerName: e.entity_name,
        taxpayerTid: e.tid,
        tidKind: e.tid_kind as 'SSN' | 'EIN',
        formType: e.form_type,
        years: e.years,
        address: e.address || undefined,
      })),
      metadata: {
        sessionId: newSession.id,
        expertId: parent.expert_id,
        assignmentIds: (callEntities as any[]).map(c => c.assignment_id),
      },
      callMode: 'hold_and_transfer',
      excludeFromNumbers,
    });
  } catch (callErr) {
    console.error('[irs-call-retry] initiateCall failed:', callErr instanceof Error ? callErr.message : String(callErr));
    // Mark the new attempt as failed; safety-net cron will pick up the chain
    await (admin.from('irs_call_sessions' as any) as any)
      .update({ status: 'failed', error_message: 'retry initiate failed' })
      .eq('id', newSession.id);
    return null;
  }

  const patch: Record<string, unknown> = {
    bland_call_id: response.call_id,
    status: 'ringing',
  };
  if (response.from_number) patch.from_number = response.from_number;
  await (admin.from('irs_call_sessions' as any) as any)
    .update(patch)
    .eq('id', newSession.id);

  console.log(
    `[irs-call-retry] retry #${newRetryCount} fired for chain ${rootId}; ` +
    `new session=${newSession.id}, call=${response.call_id}, from=${response.from_number || '(unknown)'}`,
  );

  return newSession;
}
