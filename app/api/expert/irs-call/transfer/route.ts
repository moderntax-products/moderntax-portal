/**
 * IRS Call Manual Transfer — reality check.
 *
 * Bland AI removed the `/v1/calls/{id}/transfer` REST endpoint (returns 404 as
 * of April 2026). Mid-call transfer now only happens one way: the AI says the
 * word "transfer" during the call, which triggers the bridge to the
 * `transfer_phone_number` that was set at call initiation time.
 *
 * We can't reach into an in-progress Bland call and force a transfer from
 * outside. The best we can do from a click is:
 *   • confirm the callback_phone is configured (it was set at initiation)
 *   • mark the session as transfer-requested so the UI updates expectations
 *   • tell the expert: the AI will auto-bridge when it detects an agent
 *     greeting; if it misses that, the call can't be salvaged via API
 *
 * Returning a clean 200 with the right guidance is better than the previous
 * behaviour (returning a Bland 404 + HTML error page leaked through to the UI).
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { providerForCallId } from '@/lib/voice-provider';

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { sessionId } = await request.json();
    if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 });

    const adminSupabase = createAdminClient();

    // Verify expert owns this call session
    const { data: session } = await adminSupabase
      .from('irs_call_sessions' as any)
      .select('id, expert_id, bland_call_id, status, callback_phone')
      .eq('id', sessionId)
      .single() as { data: any; error: any };

    if (!session || session.expert_id !== user.id) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    if (!session.bland_call_id) {
      return NextResponse.json({ error: 'Call not yet connected' }, { status: 400 });
    }

    if (!session.callback_phone) {
      return NextResponse.json({ error: 'No callback phone on file. Update your profile.' }, { status: 400 });
    }

    // Mark the session as "manual transfer requested" so the UI can show a
    // different message and we have an audit trail. We can't actually initiate
    // the transfer — Bland's API no longer supports it. Flag-only.
    await adminSupabase
      .from('irs_call_sessions' as any)
      .update({
        callback_status: 'waiting',
        callback_initiated_at: new Date().toISOString(),
      })
      .eq('id', sessionId);

    // Messaging adapts by provider. Retell has a real bridge_transfer tool
    // the AI will invoke on agent detection; Bland's equivalent API was
    // retired and we rely on the same AI-initiated behavior as a no-op.
    const provider = providerForCallId(session.bland_call_id);
    const message =
      provider === 'retell'
        ? `The Retell agent has the bridge_transfer tool armed. The moment it detects a live IRS agent, it will bridge this call to ${session.callback_phone} — your phone will ring within seconds. Keep the call tab open so you can see the live transcript highlight when the agent answers.`
        : `Manual transfer is not supported by Bland's current API. The AI is configured to auto-bridge to ${session.callback_phone} the moment it detects an IRS agent greeting. Keep the call running and watch for your phone to ring.`;
    const guidance =
      provider === 'retell'
        ? 'If the AI misses the agent, use End Call & Dial Direct below — you\'ll get the IRS number, CAF, and queued entities to dial yourself.'
        : 'If the AI misses the agent greeting and the call ends in voicemail or silence, the only recovery is to end this call and dial IRS manually.';

    return NextResponse.json({
      success: true,
      requires_auto_transfer: true,
      provider,
      callback_phone: session.callback_phone,
      message,
      guidance,
    });
  } catch (error) {
    console.error('Manual transfer error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Transfer failed' },
      { status: 500 }
    );
  }
}
