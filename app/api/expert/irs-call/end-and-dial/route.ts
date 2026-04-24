/**
 * IRS Call — End Bland Call & Hand Off To Direct Dial.
 *
 * POST — stops the in-progress Bland call and returns everything the expert
 * needs to dial IRS PPS themselves: number to call, CAF, SOR inbox, the
 * entities that were queued for this session, and which DTMF options to press
 * to get back to the same queue position quickly.
 *
 * This replaces the old "Transfer to My Phone" path. Bland's transfer API
 * was retired, so the only reliable fallback when auto-bridge misses an
 * agent is: kill the AI call → dial manually. This endpoint performs the
 * kill and packages the manual-dial data server-side so the UI can show it
 * instantly (no waiting, no context switching).
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { stopCall as stopCallViaProvider, providerForCallId } from '@/lib/voice-provider';
import { logAuditFromRequest } from '@/lib/audit';

const IRS_PPS_PHONE = '866-860-4259';

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { sessionId } = await request.json();
    if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 });

    const adminSupabase = createAdminClient();

    // Session + entities + expert profile in parallel
    const [sessionQ, entitiesQ] = await Promise.all([
      adminSupabase
        .from('irs_call_sessions' as any)
        .select('id, expert_id, bland_call_id, status, caf_number, expert_name, expert_fax, expert_sor_id, callback_phone')
        .eq('id', sessionId)
        .single(),
      adminSupabase
        .from('irs_call_entities' as any)
        .select('taxpayer_name, taxpayer_tid, form_type, tax_years')
        .eq('call_session_id', sessionId),
    ]);

    const session: any = sessionQ.data;
    if (!session || session.expert_id !== user.id) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    // Stop the AI call via whichever provider started it. Best-effort — if
    // the call already ended (Bland 404 "Call not found" / Retell 404) the
    // provider helpers treat that as success.
    let blandStopped = false;
    if (session.bland_call_id) {
      try {
        await stopCallViaProvider(providerForCallId(session.bland_call_id), session.bland_call_id);
        blandStopped = true;
      } catch (err) {
        console.error(`[end-and-dial] stopCall failed for ${session.bland_call_id}:`, err);
      }
    }

    // Mark our session as cancelled so it falls out of active-call UI.
    await adminSupabase
      .from('irs_call_sessions' as any)
      .update({
        status: 'cancelled',
        ended_at: new Date().toISOString(),
        error_message: 'Cancelled via End Call & Dial Direct',
      })
      .eq('id', sessionId);

    await logAuditFromRequest(adminSupabase, request, {
      action: 'irs_call_cancelled',
      userId: user.id,
      userEmail: user.email || '',
      resourceType: 'irs_call_session',
      resourceId: sessionId,
      details: {
        reason: 'manual_end_and_dial',
        bland_stopped: blandStopped,
        bland_call_id: session.bland_call_id,
      },
    });

    // Assemble the dial-direct payload. The UI renders this as copy-friendly
    // blocks so the expert can get through PPS IVR without fumbling.
    const entities = (entitiesQ.data || []) as any[];
    const hasSSN = entities.some(e => String(e.taxpayer_tid || '').replace(/\D/g, '').length === 9 && String(e.form_type || '').startsWith('1040'));
    const hasEIN = entities.some(e => !(String(e.taxpayer_tid || '').replace(/\D/g, '').length === 9 && String(e.form_type || '').startsWith('1040')));
    const ivrPath = hasSSN && !hasEIN
      ? ['Press 1 (English)', 'Press 2 (Individual account inquiries)']
      : ['Press 1 (English)', 'Press 3 (Business account inquiries)'];

    return NextResponse.json({
      success: true,
      bland_stopped: blandStopped,
      dialDirect: {
        phone: IRS_PPS_PHONE,
        ivr_path: ivrPath,
        caf_number: session.caf_number || null,
        expert_name: session.expert_name || null,
        expert_fax: session.expert_fax || null,
        sor_inbox: session.expert_sor_id || null,
        entities: entities.map(e => ({
          taxpayer_name: e.taxpayer_name,
          taxpayer_tid: e.taxpayer_tid,
          form_type: e.form_type,
          tax_years: e.tax_years,
        })),
      },
      guidance:
        'The Bland AI call has been ended. Dial the number above, follow the IVR path, ' +
        'and provide your CAF number when the agent asks. The entities below are exactly ' +
        'what you had queued — no context lost.',
    });
  } catch (error) {
    console.error('[end-and-dial] error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to end call' },
      { status: 500 },
    );
  }
}
