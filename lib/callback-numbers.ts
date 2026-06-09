/**
 * Callback-number pool for the autonomous IRS callback handler (server-only).
 *
 * IRS PPS calls + texts the EXACT number we provide during the call. So we hand
 * the agent a dedicated, AI-answerable DID from this pool; IRS calls/texts it;
 * we map the inbound back to its session and resume with the AI.
 *
 * Rules:
 *   - ≤ 5 simultaneous active callbacks per expert (practitioner SSN/CAF).
 *   - Atomic claim (CAS on status='available') so two concurrent fires can't
 *     grab the same number.
 *   - Graceful degrade: if the pool table isn't migrated yet, assign returns
 *     null and callers fall back to the legacy behavior (expert's own phone).
 */
import type { createAdminClient } from './supabase-server';

type Admin = ReturnType<typeof createAdminClient>;

export const MAX_CALLBACKS_PER_EXPERT = 5;

export interface AssignedCallback {
  numberId: string;
  phoneNumber: string;     // E.164, e.g. +13045551234
  digits: string;          // bare digits for the agent to key in: 3045551234
}

/** Bare 10/11-digit string the voice agent keys into the IRS callback prompt. */
export function toDigits(e164: string): string {
  const d = (e164 || '').replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

/**
 * Claim a free pool number for this session/expert. Returns null when the pool
 * isn't migrated, the per-expert cap (5) is hit, or no number is free —
 * callers then fall back to the expert's own phone (legacy behavior).
 */
export async function assignCallbackNumber(admin: Admin, expertId: string, sessionId: string): Promise<AssignedCallback | null> {
  // Per-expert concurrency cap.
  const { count, error: cErr } = await admin.from('callback_numbers' as any)
    .select('id', { count: 'exact', head: true })
    .eq('status', 'assigned').eq('assigned_expert_id', expertId) as { count: number | null; error: any };
  if (cErr) return null; // table missing / not migrated → graceful no-op
  if ((count || 0) >= MAX_CALLBACKS_PER_EXPERT) {
    console.warn(`[callback-numbers] expert ${expertId} at cap (${MAX_CALLBACKS_PER_EXPERT}); no number assigned`);
    return null;
  }

  // Grab one available, voice+SMS capable number.
  const { data: candidates } = await admin.from('callback_numbers' as any)
    .select('id, phone_number')
    .eq('status', 'available').eq('voice_enabled', true).eq('sms_enabled', true)
    .order('created_at', { ascending: true }).limit(5) as { data: any[] | null };

  for (const c of candidates || []) {
    // Atomic claim — only succeeds if still available.
    const { data: claimed } = await admin.from('callback_numbers' as any)
      .update({ status: 'assigned', assigned_session_id: sessionId, assigned_expert_id: expertId, assigned_at: new Date().toISOString() } as any)
      .eq('id', c.id).eq('status', 'available')
      .select('id, phone_number').maybeSingle() as { data: any };
    if (claimed) {
      // Claim the number for this session now (so the agent can read it). The
      // session's callback_state only flips to 'waiting' once the agent actually
      // ACCEPTS the callback on the call (set by the completion webhook); if no
      // callback is taken, the webhook releases the number.
      await admin.from('irs_call_sessions' as any)
        .update({ callback_number_id: claimed.id } as any).eq('id', sessionId);
      return { numberId: claimed.id, phoneNumber: claimed.phone_number, digits: toDigits(claimed.phone_number) };
    }
  }
  console.warn('[callback-numbers] no free pool number available');
  return null;
}

/** Release the session's assigned number back to the pool. */
export async function releaseCallbackNumber(admin: Admin, sessionId: string): Promise<void> {
  const { data: s } = await admin.from('irs_call_sessions' as any)
    .select('callback_number_id').eq('id', sessionId).maybeSingle() as { data: any };
  if (!s?.callback_number_id) return;
  await admin.from('callback_numbers' as any)
    .update({ status: 'available', assigned_session_id: null, assigned_expert_id: null, assigned_at: null } as any)
    .eq('id', s.callback_number_id);
}

/** Inbound lookup: which session is waiting on a call/text to this number? */
export async function findSessionByCallbackNumber(admin: Admin, e164: string): Promise<{ sessionId: string; numberId: string } | null> {
  const { data: num } = await admin.from('callback_numbers' as any)
    .select('id, assigned_session_id').eq('phone_number', e164).eq('status', 'assigned').maybeSingle() as { data: any };
  if (!num?.assigned_session_id) return null;
  return { sessionId: num.assigned_session_id, numberId: num.id };
}
