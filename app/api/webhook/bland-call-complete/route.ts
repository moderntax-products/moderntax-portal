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

export async function POST(request: NextRequest) {
  try {
    // Validate webhook secret
    const webhookSecret = request.headers.get('x-bland-secret') ||
                          request.headers.get('x-webhook-secret') ||
                          request.headers.get('authorization');
    const expectedSecret = process.env.BLAND_WEBHOOK_SECRET;

    if (expectedSecret && webhookSecret !== expectedSecret && webhookSecret !== `Bearer ${expectedSecret}`) {
      console.error('Bland webhook: invalid secret');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
    } = body;

    if (!call_id) {
      return NextResponse.json({ error: 'call_id required' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // Find the call session
    const { data: session } = await adminSupabase
      .from('irs_call_sessions' as any)
      .select('id, expert_id, cost_per_minute, initiated_at')
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

    // Determine session status
    const sessionStatus = completed ? 'completed' : (error_message ? 'failed' : 'completed');

    // Auto-detect coaching tags
    const coachingTags: string[] = [];
    if (sessionStatus === 'completed') coachingTags.push('completed');
    if (holdDurationSeconds && holdDurationSeconds > 1800) coachingTags.push('long_hold');
    if (transcriptText.toLowerCase().includes('name') && transcriptText.toLowerCase().includes('match')) {
      coachingTags.push('name_mismatch');
    }
    if (transcriptText.toLowerCase().includes('wet signature')) {
      coachingTags.push('esig_rejected');
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

    return NextResponse.json({ received: true, sessionId: session.id });
  } catch (error) {
    console.error('Bland webhook error:', error);
    // Return 200 to prevent Bland from retrying on our errors
    return NextResponse.json({ received: true, error: 'Processing failed' });
  }
}
