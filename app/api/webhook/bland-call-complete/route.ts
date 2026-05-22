/**
 * Bland AI Call Completion Webhook
 * POST — Receives call completion data from Bland AI
 *
 * Updates irs_call_sessions with recording, transcript, and auto-detected outcomes.
 * Parses transcript to identify per-entity results and coaching tags.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { parseTranscriptOutcomes, extractAgentInfo } from '@/lib/bland';
import { requireHeaderSecret } from '@/lib/auth-util';

export async function POST(request: NextRequest) {
  try {
    // Validate webhook secret (fail closed — reject if env var is not set)
    const unauthorized = requireHeaderSecret(request, 'x-bland-secret', process.env.BLAND_WEBHOOK_SECRET);
    if (unauthorized) {
      console.error('Bland webhook: invalid or missing secret');
      return unauthorized;
    }

    const body = await request.json();
    const {
      call_id,
      completed,
      recording_url,
      transcripts,
      concatenated_transcript,
      summary,
      call_length, // minutes
      answered_by,
      error_message,
      transferred_to,
      call_ended_by,
    } = body;

    if (!call_id) {
      return NextResponse.json({ error: 'call_id required' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // Find the call session
    const { data: session } = await adminSupabase
      .from('irs_call_sessions' as any)
      .select('id, expert_id, cost_per_minute, initiated_at, callback_mode, callback_status, callback_phone')
      .eq('bland_call_id', call_id)
      .single() as { data: any; error: any };

    if (!session) {
      console.error(`Bland webhook: no session found for call_id ${call_id}`);
      // Still return 200 to prevent Bland from retrying
      return NextResponse.json({ received: true, warning: 'session_not_found' });
    }

    // Compute duration and cost
    const durationSeconds = call_length ? Math.round(call_length * 60) : null;
    const estimatedCost = durationSeconds
      ? Math.round((durationSeconds / 60) * (session.cost_per_minute || 0.09) * 100) / 100
      : null;

    // Estimate hold duration (time from call start to when agent answered)
    // This is approximate — a more precise approach would analyze transcript timestamps
    let holdDurationSeconds: number | null = null;
    if (transcripts && transcripts.length > 0) {
      // Find the first non-IVR agent response (heuristic: first "user" message after 60s)
      const firstAgentMsg = transcripts.find(
        (t: any) => t.role === 'user' && t.timestamp > 60
      );
      if (firstAgentMsg) {
        holdDurationSeconds = Math.round(firstAgentMsg.timestamp);
      }
    }

    // Extract IRS agent info from transcript
    const transcriptText = concatenated_transcript || '';
    const agentInfo = extractAgentInfo(transcriptText);

    // Auto-detect coaching tags (declared early for use in callback handling)
    const coachingTags: string[] = [];

    // Determine session status and transfer outcome
    let sessionStatus = completed ? 'completed' : (error_message ? 'failed' : 'completed');
    const lower = transcriptText.toLowerCase();

    // --- Detect what actually happened ---
    const agentAnswered = !!(session.agent_answered_at) ||
      lower.includes('how can i help you') ||
      lower.includes('my name is') ||
      lower.includes('my id number is') ||
      lower.includes('practitioner priority service');

    const transferAttempted = !!(session.callback_status === 'transferring') || !!transferred_to;

    // Did the expert actually speak to the agent?
    // Look for transcript lines from "assistant" AFTER the agent greeting that contain real conversation
    const expertSpoke = transferred_to && call_ended_by !== 'ASSISTANT';

    // Did the IRS agent hang up before expert connected?
    const agentHungUp = agentAnswered && !transferAttempted &&
      (lower.includes('call back') || lower.includes('goodbye') || call_ended_by === 'USER');

    const agentHungUpDuringTransfer = transferAttempted && !expertSpoke &&
      (lower.includes('i can only hold') || lower.includes('need to call back') || call_ended_by === 'USER');

    // Update callback_status based on actual outcome
    let callbackStatusUpdate: string | null = null;

    if (transferred_to) {
      // Bland confirmed the transfer happened
      callbackStatusUpdate = 'connected';
      coachingTags.push('expert_connected');
    } else if (session.callback_status === 'transferring') {
      // We tried to transfer but Bland didn't confirm
      if (agentHungUpDuringTransfer) {
        callbackStatusUpdate = 'failed';
        coachingTags.push('agent_hung_up_during_transfer');
      } else {
        callbackStatusUpdate = 'no_answer';
        coachingTags.push('expert_no_answer');
      }
    } else if (session.callback_mode === 'irs_callback') {
      // IRS callback mode — check if callback was accepted
      const callbackAccepted = lower.includes('callback') &&
        (lower.includes('confirm') || lower.includes('schedul') || lower.includes('will call'));
      if (callbackAccepted) {
        callbackStatusUpdate = 'waiting';
        coachingTags.push('irs_callback_accepted');
      }
    } else if (agentAnswered && !transferAttempted) {
      // Agent answered but no transfer was attempted
      callbackStatusUpdate = 'failed';
      coachingTags.push('no_transfer_attempted');
    } else if (session.callback_status === 'holding' || session.callback_status === 'waiting') {
      // Was holding/waiting but call ended without reaching agent
      callbackStatusUpdate = call_ended_by === 'ASSISTANT' ? 'failed' : 'no_answer';
    }

    if (callbackStatusUpdate) {
      await adminSupabase
        .from('irs_call_sessions' as any)
        .update({
          callback_status: callbackStatusUpdate,
          ...(callbackStatusUpdate === 'connected' ? { callback_connected_at: new Date().toISOString() } : {}),
        })
        .eq('id', session.id);
    }

    // Time-tracking auto-instrumentation for bland calls. We open a session
    // on `connected` (live agent reached) and close it when this webhook
    // fires marking the call done. Sessions for callback-accepted-but-never-
    // connected calls don't get time-logged — the expert wasn't actually on
    // the phone with anyone.
    try {
      if (session.expert_id) {
        if (callbackStatusUpdate === 'connected') {
          // Open or extend
          const { data: open } = await adminSupabase
            .from('expert_time_logs')
            .select('id')
            .eq('expert_id', session.expert_id)
            .eq('source', 'bland_call')
            .eq('source_id', session.id)
            .is('end_at', null)
            .maybeSingle() as { data: any; error: any };
          const now = new Date().toISOString();
          if (!open) {
            await (adminSupabase.from('expert_time_logs') as any).insert({
              expert_id: session.expert_id,
              start_at: now, end_at: null,
              break_minutes: 0, hours_worked: 0, tins_completed: 0,
              source: 'bland_call',
              source_id: session.id,
              notes: `Auto-opened by Bland call ${session.id.slice(0, 8)} reaching live IRS agent`,
            } as any);
          }
          // No-op on extend; without last_activity_at column there's nothing
          // useful to write on existing-session ping. The idle-cleanup cron
          // will still close at hard-cap based on start_at.
        } else if (sessionStatus === 'completed' || sessionStatus === 'failed') {
          // Close any open bland_call session for this irs_call_sessions row
          const { data: open } = await adminSupabase
            .from('expert_time_logs')
            .select('id, start_at')
            .eq('expert_id', session.expert_id)
            .eq('source', 'bland_call')
            .eq('source_id', session.id)
            .is('end_at', null)
            .maybeSingle() as { data: any; error: any };
          if (open) {
            const endIso = new Date().toISOString();
            const hours = Math.round((new Date(endIso).getTime() - new Date(open.start_at).getTime()) / 1000 / 3600 * 100) / 100;
            await (adminSupabase.from('expert_time_logs') as any).update({
              end_at: endIso,
              hours_worked: hours,
            }).eq('id', open.id);
          }
        }
      }
    } catch (timeErr) {
      console.warn('[bland-call-complete] Time-log auto-update failed (non-fatal):', timeErr instanceof Error ? timeErr.message : timeErr);
    }

    // If agent answered but expert didn't connect, flag for retry
    if (agentAnswered && callbackStatusUpdate !== 'connected' && callbackStatusUpdate !== 'waiting') {
      coachingTags.push('needs_retry');
    }

    // Populate coaching tags
    if (sessionStatus === 'completed') coachingTags.push('completed');
    if (holdDurationSeconds && holdDurationSeconds > 1800) coachingTags.push('long_hold');
    if (session.callback_mode === 'transfer') coachingTags.push('hold_and_transfer');
    if (session.callback_mode === 'irs_callback') coachingTags.push('irs_callback');
    if (agentAnswered) coachingTags.push('agent_reached');
    if (agentHungUp) coachingTags.push('agent_hung_up');

    // Auto-detect 8821 rejection reasons from transcript
    if (lower.includes('name') && (lower.includes('match') || lower.includes('doesn\'t match') || lower.includes('does not match'))) {
      coachingTags.push('8821_name_mismatch');
    }
    if (lower.includes('wet signature') || lower.includes('original signature') || lower.includes('ink signature')) {
      coachingTags.push('8821_esig_rejected');
    }
    if (lower.includes('address') && (lower.includes('doesn\'t match') || lower.includes('does not match') || lower.includes('wrong address') || lower.includes('invalid address'))) {
      coachingTags.push('8821_bad_address');
    }
    if ((lower.includes('ein') || lower.includes('employer identification')) && (lower.includes('doesn\'t match') || lower.includes('does not match') || lower.includes('incorrect') || lower.includes('wrong'))) {
      coachingTags.push('8821_wrong_ein');
    }
    if ((lower.includes('social security') || lower.includes('ssn')) && (lower.includes('doesn\'t match') || lower.includes('does not match') || lower.includes('incorrect') || lower.includes('wrong'))) {
      coachingTags.push('8821_wrong_ssn');
    }
    if (lower.includes('8821') && (lower.includes('not on file') || lower.includes('no record') || lower.includes('don\'t have'))) {
      coachingTags.push('8821_not_on_file');
    }
    if (lower.includes('caf') && (lower.includes('not on file') || lower.includes('not authorized') || lower.includes('no record'))) {
      coachingTags.push('caf_not_on_file');
    }
    if (lower.includes('tax year') && (lower.includes('missing') || lower.includes('not listed') || lower.includes('incorrect'))) {
      coachingTags.push('8821_wrong_tax_years');
    }

    // Update session
    const sessionUpdate: Record<string, unknown> = {
      status: sessionStatus,
      ended_at: new Date().toISOString(),
      duration_seconds: durationSeconds,
      hold_duration_seconds: holdDurationSeconds,
      recording_url: recording_url || null,
      transcript_json: transcripts || null,
      concatenated_transcript: transcriptText || null,
      call_summary: summary || null,
      estimated_cost: estimatedCost,
      irs_agent_name: agentInfo.name || null,
      irs_agent_badge: agentInfo.badge || null,
      coaching_tags: coachingTags.length > 0 ? coachingTags : null,
    };

    if (error_message) {
      sessionUpdate.error_message = error_message;
    }

    if (holdDurationSeconds) {
      sessionUpdate.connected_at = new Date(
        new Date(session.initiated_at).getTime() + holdDurationSeconds * 1000
      ).toISOString();
    }

    await adminSupabase
      .from('irs_call_sessions' as any)
      .update(sessionUpdate)
      .eq('id', session.id);

    // Auto-detect per-entity outcomes from transcript
    const { data: callEntities } = await adminSupabase
      .from('irs_call_entities' as any)
      .select('id, taxpayer_name, outcome')
      .eq('call_session_id', session.id)
      .order('created_at', { ascending: true }) as { data: any[]; error: any };

    if (callEntities && callEntities.length > 0 && transcriptText) {
      const detectedOutcomes = parseTranscriptOutcomes(transcriptText, callEntities.length);

      for (let i = 0; i < callEntities.length; i++) {
        const entity = callEntities[i];
        const detected = detectedOutcomes[i];

        // Only auto-update if no outcome was already set (e.g., by mid-call fax tool)
        if (!entity.outcome && detected.outcome !== 'other') {
          await adminSupabase
            .from('irs_call_entities' as any)
            .update({
              outcome: detected.outcome,
              outcome_notes: detected.notes,
            })
            .eq('id', entity.id);
        }
      }

      // Add multi-entity tag if applicable
      if (callEntities.length > 1) {
        coachingTags.push('multi_entity');
        await adminSupabase
          .from('irs_call_sessions' as any)
          .update({ coaching_tags: coachingTags })
          .eq('id', session.id);
      }
    }

    // Download and store recording in Supabase storage for long-term retention
    if (recording_url) {
      try {
        const recordingResponse = await fetch(recording_url);
        if (recordingResponse.ok) {
          const audioBlob = await recordingResponse.blob();
          const storagePath = `call-recordings/${session.id}/recording.mp3`;

          const { error: uploadError } = await adminSupabase.storage
            .from('uploads')
            .upload(storagePath, audioBlob, {
              contentType: 'audio/mpeg',
              upsert: true,
            });

          if (!uploadError) {
            await adminSupabase
              .from('irs_call_sessions' as any)
              .update({ recording_storage_path: storagePath })
              .eq('id', session.id);
          } else {
            console.error('Failed to store recording:', uploadError);
          }
        }
      } catch (dlError) {
        console.error('Failed to download recording for storage:', dlError);
      }
    }

    // Log audit event
    try {
      await adminSupabase.from('audit_log' as any).insert({
        user_email: '',
        action: sessionStatus === 'completed' ? 'irs_call_completed' : 'irs_call_failed',
        entity_type: 'irs_call_session',
        entity_id: session.id,
        details: {
          bland_call_id: call_id,
          duration_seconds: durationSeconds,
          hold_duration_seconds: holdDurationSeconds,
          estimated_cost: estimatedCost,
          irs_agent: agentInfo,
          entity_count: callEntities?.length || 0,
          answered_by,
        },
      } as any);
    } catch (auditErr) {
      console.error('Audit log failed:', auditErr);
    }

    // MOD-211 auto-retry coordinator. Classifies the call outcome
    // (high_volume_rejected vs callback_scheduled vs agent_reached) and,
    // if retryable, fires a fresh attempt from a different from-number.
    // Best-effort — wrapped so a retry-coordinator failure never breaks
    // the webhook ack to bland.
    try {
      const { handleCompletedCall } = await import('@/lib/irs-call-retry');
      const retryResult = await handleCompletedCall(session.id);
      console.log(
        `[bland-webhook] retry coordinator: outcome=${retryResult.outcome} action=${retryResult.action}` +
        (retryResult.newSessionId ? ` newSession=${retryResult.newSessionId}` : '') +
        (retryResult.chainRootId ? ` chainRoot=${retryResult.chainRootId}` : ''),
      );
    } catch (retryErr) {
      console.error('[bland-webhook] auto-retry coordinator failed (non-blocking):', retryErr);
    }

    return NextResponse.json({ received: true, sessionId: session.id });
  } catch (error) {
    console.error('Bland webhook error:', error);
    // Return 200 to prevent Bland from retrying on our errors
    return NextResponse.json({ received: true, error: 'Processing failed' });
  }
}
