/**
 * POST /api/webhook/retell-inbound
 *
 * Retell inbound webhook for the IRS callback. Configure as the callback DIDs'
 * `inbound_webhook_url` (with their `inbound_agent_id` set to the resume agent).
 * When IRS dials one of our pool numbers, Retell calls this with the event
 * `call_inbound` and we respond with the agent + dynamic variables for THIS
 * callback's session, so the AI resumes the exact transcript request.
 *
 * Retell expects: { call_inbound: { override_agent_id?, dynamic_variables?, metadata? } }
 * Returning an empty object lets the call proceed with the number's default agent
 * (or be rejected) — we do that when no waiting session maps to the number.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { findSessionByCallbackNumber } from '@/lib/callback-numbers';
import { buildResumeContext } from '@/lib/irs-callback-resume';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({}); }

  // Retell sends { event: 'call_inbound', call_inbound: { from_number, to_number, agent_id } }
  const inbound = body?.call_inbound || body;
  const toNumber: string = inbound?.to_number || '';   // our callback DID IRS dialed
  const fromNumber: string = inbound?.from_number || '';
  if (!toNumber) return NextResponse.json({});

  try {
    const admin = createAdminClient();
    const match = await findSessionByCallbackNumber(admin, toNumber);
    if (!match) {
      console.warn(`[retell-inbound] call to ${toNumber} from ${fromNumber} — no waiting session; default handling`);
      return NextResponse.json({});
    }

    const ctx = await buildResumeContext(match.sessionId);
    if (!ctx) {
      console.error(`[retell-inbound] session ${match.sessionId} found but resume context could not be built`);
      return NextResponse.json({});
    }

    // Mark the callback connected.
    await admin.from('irs_call_sessions' as any).update({
      callback_state: 'answered',
      callback_connected_at: new Date().toISOString(),
      status: 'speaking_to_agent',
    } as any).eq('id', match.sessionId);

    const resumeAgentId = process.env.RETELL_IRS_INBOUND_AGENT_ID;
    console.log(`[retell-inbound] IRS callback to ${toNumber} → resuming session ${match.sessionId} (${ctx.variables.entity_count} entities, creds=${ctx.credentialsAvailable})`);

    return NextResponse.json({
      call_inbound: {
        ...(resumeAgentId ? { override_agent_id: resumeAgentId } : {}),
        dynamic_variables: ctx.variables,
        metadata: { session_id: match.sessionId, expert_id: ctx.expertId, mode: 'callback_resume' },
      },
    });
  } catch (e) {
    console.error('[retell-inbound] handler error:', e instanceof Error ? e.message : e);
    return NextResponse.json({});
  }
}
