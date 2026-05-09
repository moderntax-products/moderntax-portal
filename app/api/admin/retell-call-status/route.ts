/**
 * GET /api/admin/retell-call-status?id=call_xxx
 *
 * Returns the live Retell call state for a given call_id. Cron-secret
 * gated so admins / scripts can poll without spinning up a session.
 *
 * Used to fill the gap until a proper Retell webhook handler is built —
 * status-update/route.ts only validates Bland's signature, so Retell
 * calls don't get progress updates pushed to us. Polling via this
 * endpoint is the bridge.
 *
 * Output mirrors the Retell call object's most-relevant fields plus our
 * derived `phase` (initiating / ringing / on_hold / speaking / ended /
 * error) so callers don't have to interpret Retell's raw `call_status`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCall } from '@/lib/retell';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const callId = request.nextUrl.searchParams.get('id');
  if (!callId || !callId.startsWith('call_')) {
    return NextResponse.json({ error: 'id query param required (must start with "call_")' }, { status: 400 });
  }

  try {
    const c = await getCall(callId);
    // Pull the matching session from our DB for cross-reference
    const admin = createAdminClient();
    const { data: session } = await admin
      .from('irs_call_sessions')
      .select('id, status, callback_status, callback_phone, expert_name')
      .eq('bland_call_id', callId)
      .maybeSingle() as any;

    return NextResponse.json({
      call_id: c.call_id,
      retell_call_status: c.call_status,
      duration_ms: c.duration_ms,
      start_timestamp: c.start_timestamp,
      end_timestamp: c.end_timestamp,
      disconnection_reason: c.disconnection_reason,
      from_number: (c as any).from_number,
      to_number: (c as any).to_number,
      transcript_chars: c.transcript ? c.transcript.length : 0,
      transcript_preview: c.transcript ? c.transcript.slice(0, 500) : null,
      transcript_tail: c.transcript && c.transcript.length > 500 ? c.transcript.slice(-500) : null,
      recording_url: c.recording_url,
      our_session: session
        ? {
            id: session.id,
            status: session.status,
            callback_status: session.callback_status,
            callback_phone: session.callback_phone,
            expert: session.expert_name,
          }
        : null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Retell fetch failed' },
      { status: 500 },
    );
  }
}
