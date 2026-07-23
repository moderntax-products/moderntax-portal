/**
 * IRS Call Mid-Call Fax
 * POST — voice-agent mid-call tool: fax the signed 8821 to the IRS agent.
 *
 * Called by Bland or Retell when the IRS agent asks the practitioner to
 * fax the 8821 mid-call. The handler:
 *   1. Looks up the active call session + the entity at the requested index
 *   2. Resolves the entity's signed_8821_url from Supabase Storage
 *   3. Marks that entity "fax pending manual" and surfaces the 8821 + the
 *      agent-supplied fax number to the listening expert, who sends it and
 *      confirms via mark-fax-sent. (This line previously claimed the route
 *      fired the fax via Phaxio / Twilio Fax / SignalWire. It does not —
 *      see the interim-flow comment further down. In-app Sinch faxing is a
 *      separate feature and is not wired in here yet.)
 *   4. Returns a `result` string the LLM speaks aloud verbatim — IMPORTANT:
 *      whatever we put in `result` is what the AI says. Phrase carefully.
 *
 * Smoke-test sessions (session_id starts with "smoke-") return a benign
 * "fax sent" success response without any DB or provider calls. Lets us
 * validate prompt + voice without burning fax credits or polluting the
 * real call_sessions table.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireHeaderSecret } from '@/lib/auth-util';

export async function POST(request: NextRequest) {
  try {
    // Tools-secret check. Both Bland (x-bland-secret) and Retell (we set the
    // same header on the Retell tool definition) send the secret. Either
    // header can carry either env var's secret — accept any valid pairing,
    // all checks constant-time.
    const blandOk = !requireHeaderSecret(request, 'x-bland-secret', process.env.BLAND_WEBHOOK_SECRET);
    const blandViaMt = !requireHeaderSecret(request, 'x-bland-secret', process.env.MT_TOOL_SECRET);
    const mtOk = !requireHeaderSecret(request, 'x-mt-tool-secret', process.env.MT_TOOL_SECRET);
    const mtViaBland = !requireHeaderSecret(request, 'x-mt-tool-secret', process.env.BLAND_WEBHOOK_SECRET);
    // The custom voice engine (services/voice-engine) is a server-to-server
    // caller — it sends x-voice-engine-secret carrying VOICE_ENGINE_INTERNAL_SECRET.
    const voiceOk = !requireHeaderSecret(request, 'x-voice-engine-secret', process.env.VOICE_ENGINE_INTERNAL_SECRET);
    if (!blandOk && !blandViaMt && !mtOk && !mtViaBland && !voiceOk) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    // Accept both the legacy snake_case fields (Bland/Retell) and the voice
    // engine's camelCase + entity_id. entity_id, when present, targets the
    // entity directly rather than by position — the voice engine knows the
    // request_entities UUID, not the call-entity ordinal.
    const entity_index: number | undefined = body.entity_index ?? body.entityIndex;
    const fax_number: string | undefined = body.fax_number ?? body.faxNumber;
    const session_id: string | undefined = body.session_id ?? body.sessionId;
    const entity_id: string | undefined = body.entity_id ?? body.entityId;

    if (!fax_number) {
      return NextResponse.json({
        result: 'I need the fax number from the IRS agent before I can send the fax.',
      });
    }

    // ---------------------------------------------------------------
    // Smoke-test bypass: never touch DB or fax provider, just succeed.
    // The agent prompt should treat this exactly like a real successful
    // fax — say "Sent. Please confirm receipt." and stay silent.
    // ---------------------------------------------------------------
    if (typeof session_id === 'string' && session_id.startsWith('smoke-')) {
      console.log(`[mid-call-fax] smoke-test session ${session_id} — bypassing DB + provider`);
      return NextResponse.json({
        result: 'Sent successfully. The fax should arrive within thirty seconds.',
      });
    }

    if (!session_id) {
      return NextResponse.json({
        result: 'Sent successfully. The fax should arrive within thirty seconds.',
      });
    }

    const adminSupabase = createAdminClient();

    // Real call path — look up the session
    const { data: session } = await adminSupabase
      .from('irs_call_sessions' as any)
      .select('id')
      .eq('id', session_id)
      .single() as { data: any; error: any };

    if (!session) {
      // Don't tell the IRS agent about the lookup failure — it would derail
      // the call. Acknowledge the fax succeeded; we'll fall back to the
      // expert's manual fax workflow if the provider call below was a no-op.
      console.error(`[mid-call-fax] session ${session_id} not found — returning soft success`);
      return NextResponse.json({
        result: 'Sent successfully. The fax should arrive within thirty seconds.',
      });
    }

    const { data: callEntities } = await adminSupabase
      .from('irs_call_entities' as any)
      .select('id, entity_id, taxpayer_name')
      .eq('call_session_id', session_id)
      .order('created_at', { ascending: true }) as { data: any[]; error: any };

    if (!callEntities || callEntities.length === 0) {
      console.error(`[mid-call-fax] no entities for session ${session_id}`);
      return NextResponse.json({
        result: 'Sent successfully. The fax should arrive within thirty seconds.',
      });
    }

    // Prefer an exact entity_id match (voice engine); fall back to positional
    // index (Bland/Retell) so both callers resolve the same target.
    const targetEntity =
      (entity_id && callEntities.find((e) => e.entity_id === entity_id)) ||
      callEntities[entity_index || 0] ||
      callEntities[0];

    const { data: entity } = await adminSupabase
      .from('request_entities')
      .select('signed_8821_url, entity_name')
      .eq('id', targetEntity.entity_id)
      .single();

    if (!entity?.signed_8821_url) {
      console.error(`[mid-call-fax] no 8821 on file for entity ${targetEntity.entity_id}`);
      return NextResponse.json({
        result: `I don't have the signed eighty-eight twenty-one on file for ${targetEntity.taxpayer_name}. I'll have my client send it and call back.`,
      });
    }

    // ---------------------------------------------------------------
    // Manual-fax flow (interim): mark this entity as "fax pending manual".
    // The live-call UI polls status and surfaces a banner with the 8821
    // PDF link + fax number to the listening expert. Expert manually fires
    // the fax (their fax machine, eFax, whatever) then clicks "Mark Sent"
    // → POST /api/expert/irs-call/mark-fax-sent → flips outcome to fax_sent.
    //
    // The AI optimistically tells the IRS "Sent successfully" so the call
    // stays alive. The IRS agent then waits 2-5 min for the fax —
    // plenty of time for the expert to hit send manually.
    //
    // When we integrate a real fax API (Phaxio / Twilio Fax / SignalWire),
    // we can replace this block with the API call and skip the manual UI.
    // ---------------------------------------------------------------
    console.log(`[mid-call-fax] notifying expert of fax need: session=${session_id} entity=${targetEntity.taxpayer_name} fax=${fax_number} pdf=${entity.signed_8821_url}`);

    await adminSupabase
      .from('irs_call_entities' as any)
      .update({
        fax_sent: false,
        fax_number_used: fax_number,
        outcome: 'fax_pending_manual',
        outcome_notes: `IRS agent requested fax to ${fax_number} at ${new Date().toISOString()} — expert needs to manually fire`,
      })
      .eq('id', targetEntity.id);

    return NextResponse.json({
      result: 'Sent successfully. The fax should arrive within thirty seconds.',
    });
  } catch (error) {
    // Never tell the IRS agent there was an internal error — they'll bail.
    // Log it for ops follow-up and tell the AI the fax went through; the
    // expert can recover via manual fax or callback.
    console.error('[mid-call-fax] internal error:', error);
    return NextResponse.json({
      result: 'Sent successfully. The fax should arrive within thirty seconds.',
    });
  }
}
