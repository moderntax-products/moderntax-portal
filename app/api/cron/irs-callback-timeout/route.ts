/**
 * GET /api/cron/irs-callback-timeout
 *
 * Sweeps accepted IRS callbacks that never connected and re-queues an outbound
 * attempt. IRS callbacks are effectively one-shot and same-day, so:
 *   - 'imminent' (IRS texted ~10m warning) but no inbound within IMMINENT_MIN → missed
 *   - 'waiting'  (callback accepted) but nothing within WAITING_HOURS         → missed
 *
 * On miss: free the AI callback number, mark callback_state='missed', and hand
 * the session to the retry coordinator (as wait_too_long_no_callback, which is
 * retryable) so it re-fires from a fresh from-number.
 *
 * Auth: CRON_SECRET bearer. Suggested: every 5 min during IRS hours.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { releaseCallbackNumber } from '@/lib/callback-numbers';
import { handleCompletedCall } from '@/lib/irs-call-retry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const IMMINENT_TIMEOUT_MIN = 30;   // texted but no call within 30 min
const WAITING_TIMEOUT_HOURS = 4;   // accepted but nothing within 4h (same-day callbacks)

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();
  const now = Date.now();

  // Pull accepted callbacks still awaiting an inbound. (Graceful: if the
  // callback_state column isn't migrated, this query errors → 0 handled.)
  const { data: open, error } = await admin.from('irs_call_sessions' as any)
    .select('id, callback_state, callback_initiated_at, callback_sms_received_at')
    .eq('callback_status', 'accepted')
    .in('callback_state', ['waiting', 'imminent'])
    .limit(200) as { data: any[] | null; error: any };
  if (error) return NextResponse.json({ ok: true, migrated: false, detail: error.message });

  let missed = 0, retried = 0;
  for (const s of open || []) {
    const acceptedMs = s.callback_initiated_at ? new Date(s.callback_initiated_at).getTime() : 0;
    const smsMs = s.callback_sms_received_at ? new Date(s.callback_sms_received_at).getTime() : 0;
    const isMissed =
      (s.callback_state === 'imminent' && smsMs && now - smsMs > IMMINENT_TIMEOUT_MIN * 60_000) ||
      (acceptedMs && now - acceptedMs > WAITING_TIMEOUT_HOURS * 3600_000);
    if (!isMissed) continue;

    await admin.from('irs_call_sessions' as any)
      .update({ callback_state: 'missed', classified_outcome: 'wait_too_long_no_callback' } as any)
      .eq('id', s.id);
    try { await releaseCallbackNumber(admin, s.id); } catch { /* best-effort */ }
    missed++;
    try {
      const r = await handleCompletedCall(s.id);
      if (r.action === 'retry_fired') retried++;
    } catch (e) { console.error(`[irs-callback-timeout] retry for ${s.id} failed:`, e instanceof Error ? e.message : e); }
  }

  return NextResponse.json({ ok: true, scanned: (open || []).length, missed, retried });
}
