/**
 * Voice-provider router — abstracts away whether we're using Bland or Retell.
 *
 * Set `CALL_PROVIDER=retell` in env to route new outbound calls through
 * Retell (after scripts/retell-setup.ts has provisioned the agent + phone).
 * Default is `bland` for safety during the migration window.
 *
 * Callers pass a provider-agnostic CallParams shape; the router adapts to
 * each provider's SDK. Stop / status / live-listen helpers are also routed.
 *
 * NOTE: this is a thin forwarder. The *prompt* is already provider-agnostic
 * enough (both use dynamic variables / task prompts). The main difference is
 * Bland sends the prompt per call, Retell references an agent_id.
 */

import * as bland from './bland';
import * as retell from './retell';
import { pickFromNumber } from './phone-pool';
import {
  decryptCredential,
  formatSSNForSpeech, formatDOBForSpeech,
  formatCafForSpeech, formatDigitsForSpeech,
  formatFormForSpeech, formatYearsForSpeech,
  formatNATOSpelling, ordinalWord,
} from './crypto';
import { createAdminClient } from './supabase-server';

export type VoiceProvider = 'bland' | 'retell';

export function activeProvider(): VoiceProvider {
  const v = (process.env.CALL_PROVIDER || 'bland').toLowerCase();
  return v === 'retell' ? 'retell' : 'bland';
}

/**
 * Detect which provider produced a given call_id. Bland's call_ids are
 * lowercase UUIDs (8-4-4-4-12 hex); Retell's are `call_<32 hex>`. Any
 * string starting with `call_` is treated as Retell. This lets us keep
 * storing the provider's id in the existing `bland_call_id` column
 * without a schema migration.
 */
export function providerForCallId(callId: string | null | undefined): VoiceProvider {
  if (!callId) return activeProvider();
  if (callId.startsWith('call_')) return 'retell';
  return 'bland';
}

export interface UnifiedCallParams {
  // Persona
  expertName: string;
  cafNumber: string;
  expertFax?: string;
  expertPhone?: string;
  expertAddress?: string;
  sorInbox?: string;
  voiceSampleUrl?: string;

  // Entities
  entities: {
    entityId: string;
    taxpayerName: string;
    taxpayerTid: string;
    tidKind: 'SSN' | 'EIN';
    formType: string;
    years: string[];
    address?: string;
  }[];

  // Metadata — passed through to webhooks
  metadata: {
    sessionId: string;
    expertId: string;
    assignmentIds: string[];
  };

  // Behavior
  callMode?: 'ai_full' | 'hold_and_transfer' | 'irs_callback';
  callbackPhone?: string;

  // MOD-211 auto-retry: list of from-numbers already used in this retry
  // chain. The phone-pool picker excludes these so we rotate to a fresh
  // pool slot for each retry attempt.
  excludeFromNumbers?: string[];
}

export interface UnifiedCallResponse {
  call_id: string;
  provider: VoiceProvider;
  status: string;
  /** From-number that the picker selected for this attempt. Persisted
   *  on the irs_call_sessions row so retries know what to exclude. */
  from_number?: string;
}

/**
 * Initiate an outbound call via the active provider. The Bland path
 * delegates to lib/bland.initiateCall(). The Retell path creates a
 * phone_call referencing the IRS_PPS agent with dynamic variables set.
 */
export async function initiateCall(params: UnifiedCallParams): Promise<UnifiedCallResponse> {
  const provider = activeProvider();

  if (provider === 'retell') {
    const agentId = process.env.RETELL_IRS_AGENT_ID;
    if (!agentId) throw new Error('RETELL_IRS_AGENT_ID not configured — run scripts/retell-setup.ts');

    // Pick a from-number whose area-code timezone is currently inside IRS
    // hours. This stretches our callable window from a single timezone's
    // 12 hours (7am-7pm local) to 15 hours (4am PT → 7pm PT) by rotating
    // across ET/CT/MT/PT pool entries based on the current moment.
    const picked = pickFromNumber(undefined, undefined, params.excludeFromNumbers || []);
    if (!picked) {
      throw new Error(
        'No from-number currently eligible for IRS PPS hours. ' +
        'Configure RETELL_PHONE_POOL with numbers across US timezones, or wait until a pool entry is within 7am-7pm local.',
      );
    }
    const fromNumber = picked.phone;
    console.log(`[voice-provider] using from=${picked.label || fromNumber} (${picked.tz})${(params.excludeFromNumbers?.length || 0) > 0 ? ` excluding ${params.excludeFromNumbers!.length} prior` : ''}`);

    // Load expert's stored SSN + DOB — the IRS requires the practitioner to
    // authenticate themselves (not just the client) before releasing
    // transcripts to the SOR inbox. Decrypt here and pass as dynamic
    // variables; Retell holds these in-memory only for the duration of the
    // call, never at rest. Never log plaintext.
    let expertSsnForSpeech = '';
    let expertDobForSpeech = '';
    try {
      const admin = createAdminClient();
      const { data: profile } = await (admin.from('profiles' as any) as any)
        .select('ssn_encrypted, dob_encrypted, irs_credentials_consented_at, irs_credentials_used_count')
        .eq('id', params.metadata.expertId)
        .single();
      if (profile?.ssn_encrypted && profile?.dob_encrypted && profile?.irs_credentials_consented_at) {
        const ssn = decryptCredential(profile.ssn_encrypted);
        const dob = decryptCredential(profile.dob_encrypted);
        expertSsnForSpeech = formatSSNForSpeech(ssn);
        expertDobForSpeech = formatDOBForSpeech(dob);
        // Increment usage counter — non-blocking, non-critical.
        await (admin.from('profiles' as any) as any)
          .update({ irs_credentials_used_count: (profile.irs_credentials_used_count || 0) + 1 })
          .eq('id', params.metadata.expertId);
      } else {
        console.warn(`[voice-provider] expert ${params.metadata.expertId} has no stored SSN/DOB — IRS may refuse to release transcripts`);
      }
    } catch (err) {
      console.error('[voice-provider] failed to load expert credentials:', err);
      // Proceed with empty credentials — the prompt will handle the refusal gracefully.
    }

    const res = await retell.createPhoneCall({
      from_number: fromNumber,
      to_number: '+18668604259',
      override_agent_id: agentId,
      retell_llm_dynamic_variables: (() => {
        // Flatten every piece of context into speech-ready flat variables.
        // The LLM only has to substitute {{name}} — no JSON parsing, no
        // bracketed expressions, no runtime logic. Up to MAX_ENTITIES supported.
        const MAX_ENTITIES = 5;
        const sor = params.sorInbox || 'MCA-R-31';
        const vars: Record<string, string> = {
          // Practitioner identity
          expert_name:          params.expertName,
          caf_number:           params.cafNumber,
          caf_number_speech:    formatCafForSpeech(params.cafNumber),
          expert_fax:           params.expertFax || '',
          expert_fax_speech:    formatDigitsForSpeech((params.expertFax || '').slice(0, 3)),
          expert_phone:         params.expertPhone || '',
          expert_address:       params.expertAddress || '',

          // SOR inbox — already pre-rendered in NATO
          sor_inbox:            sor,
          sor_inbox_nato:       formatNATOSpelling(sor),

          // Callback phone for IRS callback entry
          callback_phone:       (params.callbackPhone || '').replace(/\D/g, ''),

          // Session + routing
          session_id:           params.metadata.sessionId,
          entity_count:         String(params.entities.length),
          entity_count_word:    ordinalWord(params.entities.length), // not used but handy

          // Practitioner identity verification (Phase 4 STEP D)
          expert_ssn_for_speech:        expertSsnForSpeech,
          expert_dob_for_speech:        expertDobForSpeech,
          expert_credentials_available: expertSsnForSpeech ? 'true' : 'false',

          // Phone-tree routing hint for PHASE 1
          phone_tree_menu_digit: params.entities[0]?.tidKind === 'SSN' ? '2' : '3',
        };

        // Per-entity flat variables: entity_1_name, entity_1_tid_speech, etc.
        // Up to MAX_ENTITIES; unused slots left empty so {{entity_5_name}}
        // interpolates to "" rather than being dropped.
        for (let i = 0; i < MAX_ENTITIES; i++) {
          const n = i + 1;
          const e = params.entities[i];
          vars[`entity_${n}_ordinal`]     = e ? ordinalWord(n) : '';
          vars[`entity_${n}_name`]        = e ? e.taxpayerName : '';
          vars[`entity_${n}_tid_raw`]     = e ? e.taxpayerTid : '';
          vars[`entity_${n}_tid_speech`]  = e ? formatDigitsForSpeech(e.taxpayerTid) : '';
          vars[`entity_${n}_tid_kind`]    = e ? (e.tidKind === 'SSN' ? 'Social' : 'EIN') : '';
          vars[`entity_${n}_form`]        = e ? e.formType : '';
          vars[`entity_${n}_form_speech`] = e ? formatFormForSpeech(e.formType) : '';
          vars[`entity_${n}_years`]       = e ? e.years.join(', ') : '';
          vars[`entity_${n}_years_speech`] = e ? formatYearsForSpeech(e.years) : '';
          vars[`entity_${n}_address`]     = e && e.address ? e.address : '';
          // Pre-compute transcript-types phrase per entity. 1040 returns
          // include W&I; everything else is just RoA + Tax Return. This
          // removes "if 1040 then say also wage and income" conditional
          // logic from the prompt — the LLM was hallucinating "1040" any
          // time it saw the conditional even on 1120/1065/941 calls.
          if (e) {
            const isIndividual = (e.formType || '').toUpperCase().startsWith('1040');
            vars[`entity_${n}_transcripts_speech`] = isIndividual
              ? 'record of account transcript, tax return transcript, and wage and income transcript'
              : 'record of account transcript and tax return transcript';
          } else {
            vars[`entity_${n}_transcripts_speech`] = '';
          }
        }
        return vars;
      })(),
      metadata: {
        sessionId: params.metadata.sessionId,
        expertId: params.metadata.expertId,
        assignmentIds: params.metadata.assignmentIds,
      },
    });

    return { call_id: res.call_id, provider: 'retell', status: res.call_status, from_number: fromNumber };
  }

  // --- Bland fallback (current production) ---
  // Pre-fetch SSN/DOB the same way the Retell branch does. Without this,
  // when an IRS agent answers and asks the practitioner to authenticate,
  // the AI has no answer to give and the call dies unproductively (the
  // 2026-04-24 Donna Clarin pattern: 12 min agent-reached call → no
  // transcripts because verification failed). Pulled and decrypted here
  // and passed through to Bland; Bland's pathway prompt references the
  // {expert_ssn_for_speech} / {expert_dob_for_speech} variables.
  let blandExpertSsnForSpeech = '';
  let blandExpertDobForSpeech = '';
  try {
    const admin = createAdminClient();
    const { data: profile } = await (admin.from('profiles' as any) as any)
      .select('ssn_encrypted, dob_encrypted, irs_credentials_consented_at, irs_credentials_used_count')
      .eq('id', params.metadata.expertId)
      .single();
    if (profile?.ssn_encrypted && profile?.dob_encrypted && profile?.irs_credentials_consented_at) {
      const ssn = decryptCredential(profile.ssn_encrypted);
      const dob = decryptCredential(profile.dob_encrypted);
      blandExpertSsnForSpeech = formatSSNForSpeech(ssn);
      blandExpertDobForSpeech = formatDOBForSpeech(dob);
      await (admin.from('profiles' as any) as any)
        .update({ irs_credentials_used_count: (profile.irs_credentials_used_count || 0) + 1 })
        .eq('id', params.metadata.expertId);
    } else {
      console.warn(`[voice-provider:bland] expert ${params.metadata.expertId} has no stored SSN/DOB - IRS may refuse to release transcripts`);
    }
  } catch (err) {
    console.error('[voice-provider:bland] failed to load expert credentials:', err);
  }

  // Bland's lib/bland.initiateCall handles its own from-number selection
  // internally; surfacing the picked value to the caller for retry-chain
  // tracking is a Phase 2 enhancement (MOD-211).
  const blandRes = await bland.initiateCall({
    expertName: params.expertName,
    cafNumber: params.cafNumber,
    expertFax: params.expertFax,
    expertPhone: params.expertPhone,
    expertAddress: params.expertAddress,
    sorInbox: params.sorInbox,
    voiceSampleUrl: params.voiceSampleUrl,
    entities: params.entities,
    metadata: params.metadata,
    callMode: params.callMode,
    callbackPhone: params.callbackPhone,
    expertSsnForSpeech: blandExpertSsnForSpeech,
    expertDobForSpeech: blandExpertDobForSpeech,
  });
  return { call_id: blandRes.call_id, provider: 'bland', status: blandRes.status };
}

/** Stop an ongoing call (either provider). */
export async function stopCall(provider: VoiceProvider, callId: string): Promise<void> {
  if (provider === 'retell') return retell.endCall(callId);
  return bland.stopCall(callId);
}

/** Get current call status + transcript (either provider). */
export async function getCallStatus(provider: VoiceProvider, callId: string): Promise<{
  completed: boolean;
  transcript?: string;
  durationMs?: number;
  recordingUrl?: string;
  endReason?: string;
}> {
  if (provider === 'retell') {
    const r = await retell.getCall(callId);
    return {
      completed: r.call_status === 'ended' || r.call_status === 'error',
      transcript: r.transcript,
      durationMs: r.duration_ms,
      recordingUrl: r.recording_url,
      endReason: r.disconnection_reason,
    };
  }
  const b = await bland.getCallStatus(callId);
  return {
    completed: !!b.completed,
    transcript: b.concatenated_transcript,
    durationMs: typeof b.call_length === 'number' ? b.call_length * 60_000 : undefined,
    recordingUrl: b.recording_url,
    endReason: b.error_message || undefined,
  };
}

/** Live-listen WebSocket URL (provider-specific path). */
export async function getLiveListenUrl(provider: VoiceProvider, callId: string): Promise<string> {
  if (provider === 'retell') return retell.getLiveListenUrl(callId);
  return bland.getLiveListenUrl(callId);
}
