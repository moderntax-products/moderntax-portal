/**
 * Session state + checkpoints against the EXISTING irs_call_sessions table.
 *
 * Checkpoints are the drop-resilience spine (the 65-minute lesson): every
 * phase transition and consequential act is stamped as it happens, so a
 * disconnect at any point resumes from the furthest checkpoint instead of
 * re-paying the whole call. Stored in transcript_json.checkpoints — additive,
 * no migration needed; promote to columns later if querying demands it.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CONFIG } from './config';

export type Checkpoint =
  | 'dialing'
  | 'ivr_language' | 'ivr_practitioner' | 'ivr_account_type' | 'ivr_caf_entered'
  | 'ivr_lost'
  | 'hold_started' | 'overflow_rejected' | 'callback_offered' | 'callback_accepted'
  | 'agent_reached'
  | 'verified'
  | 'forms_requested'
  | 'fax_number_received'
  | 'fax_sent'
  | 'fax_confirmed'
  | 'delivery_committed'   // agent stated transcripts will be faxed/mailed
  | 'call_ended';

export interface CallSession {
  id: string;
  expertName: string;
  caf: string;
  expertFax: string;
  sorId: string | null;
  entities: Array<{ id: string; name: string; tin: string; formType: string; years: string[] }>;
  checkpoints: Array<{ at: string; label: Checkpoint; detail?: string }>;
}

let sb: SupabaseClient | null = null;
export function db(): SupabaseClient {
  if (!sb) sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseServiceKey);
  return sb;
}

export async function loadSession(sessionId: string): Promise<CallSession> {
  const { data: s, error } = await db()
    .from('irs_call_sessions')
    .select('id, expert_name, caf_number, expert_fax, expert_sor_id, transcript_json')
    .eq('id', sessionId)
    .single();
  if (error || !s) throw new Error(`session ${sessionId} not found: ${error?.message}`);

  // Entities travel in transcript_json.entities, written by the portal's
  // fire-call route when it creates the session.
  const tj = (s.transcript_json as any) || {};
  return {
    id: s.id,
    expertName: s.expert_name || '',
    caf: s.caf_number || '',
    expertFax: s.expert_fax || '',
    sorId: s.expert_sor_id || null,
    entities: Array.isArray(tj.entities) ? tj.entities : [],
    checkpoints: Array.isArray(tj.checkpoints) ? tj.checkpoints : [],
  };
}

export async function checkpoint(
  session: CallSession,
  label: Checkpoint,
  detail?: string,
): Promise<void> {
  const entry = { at: new Date().toISOString(), label, ...(detail ? { detail } : {}) };
  session.checkpoints.push(entry);
  // Read-modify-write on the jsonb; single-writer per session (one live call).
  const { data: cur } = await db()
    .from('irs_call_sessions').select('transcript_json').eq('id', session.id).single();
  const tj = ((cur?.transcript_json as any) || {});
  tj.checkpoints = session.checkpoints;
  const { error } = await db()
    .from('irs_call_sessions')
    .update({ transcript_json: tj, updated_at: new Date().toISOString() })
    .eq('id', session.id);
  if (error) console.error(`[session] checkpoint ${label} failed:`, error.message);
  else console.log(`[session ${session.id.slice(0, 8)}] ✓ ${label}${detail ? ` (${detail})` : ''}`);
}

export function furthestCheckpoint(session: CallSession): Checkpoint | null {
  return session.checkpoints.length
    ? session.checkpoints[session.checkpoints.length - 1].label
    : null;
}

/**
 * The resume brief injected into the agent prompt on a retry/callback call.
 * This is what converts a drop-after-fax into a 5-minute confirmation call
 * instead of a fresh 65-minute cycle.
 */
export function resumeBrief(session: CallSession): string | null {
  const labels = new Set(session.checkpoints.map((c) => c.label));
  if (labels.has('fax_sent') && !labels.has('fax_confirmed')) {
    const fax = session.checkpoints.find((c) => c.label === 'fax_sent');
    return `A signed Form 8821 was already faxed to the IRS at ${fax?.at} during a previous call that disconnected. Open by telling the agent you're following up to CONFIRM RECEIPT of that fax under CAF ${session.caf} — do not restart the request from scratch. If they confirm receipt, proceed straight to requesting the transcripts.`;
  }
  if (labels.has('verified')) {
    return `A previous call on this case completed verification but disconnected before finishing. Mention that you were disconnected mid-call so the agent can pick up the thread quickly.`;
  }
  return null;
}

export async function markCallEnded(
  session: CallSession,
  outcome: string,
  durationSec: number,
): Promise<void> {
  await db().from('irs_call_sessions').update({
    status: 'completed',
    classified_outcome: outcome,
    ended_at: new Date().toISOString(),
    duration_seconds: Math.round(durationSec),
  }).eq('id', session.id);
}
