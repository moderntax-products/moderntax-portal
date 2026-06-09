/**
 * Inbound IRS-callback resume agent.
 *
 * When IRS calls back the AI-answerable number we handed them, this builds the
 * dynamic variables + the resume prompt so the SAME conversational agent picks
 * up — but entering at the LIVE-AGENT stage (no IVR to navigate; a human IRS
 * agent is already on the line) and re-verifying the practitioner's SSN, which
 * IRS always asks for on a callback ("you are the one who initiated contact").
 *
 * Reuses the exact per-entity variable shape from voice-provider so the agent's
 * answers (TIN/name/form/years/transcript types) are identical to the outbound
 * call. Provider-agnostic: returns plain data the inbound webhook hands to
 * whichever provider answered.
 */
import { createAdminClient } from './supabase-server';
import { buildLiveAgentPlaybook } from './retell';
import {
  decryptCredential,
  formatSSNForSpeech, formatDOBForSpeech,
  formatCafForSpeech, formatDigitsForSpeech,
  formatFormForSpeech, formatYearsForSpeech,
  formatNATOSpelling, ordinalWord,
} from './crypto';

const MAX_ENTITIES = 5;

export interface ResumeContext {
  sessionId: string;
  expertId: string;
  variables: Record<string, string>;
  /** True when the practitioner SSN/DOB loaded — IRS will refuse otherwise. */
  credentialsAvailable: boolean;
}

/**
 * Load everything the resume agent needs for a callback session: expert
 * identity (+decrypted SSN/DOB), SOR inbox, and per-entity transcript details.
 * Returns null if the session/entities can't be loaded.
 */
export async function buildResumeContext(sessionId: string): Promise<ResumeContext | null> {
  const admin = createAdminClient();

  const { data: session } = await admin.from('irs_call_sessions' as any)
    .select('id, expert_id, caf_number, expert_name, expert_fax, expert_sor_id')
    .eq('id', sessionId).maybeSingle() as { data: any };
  if (!session) return null;

  const { data: callEntities } = await admin.from('irs_call_entities' as any)
    .select('entity_id, taxpayer_name, taxpayer_tid, form_type, tax_years, request_entities(tid_kind, address)')
    .eq('call_session_id', sessionId) as { data: any[] | null };
  if (!callEntities || callEntities.length === 0) return null;

  const { data: profile } = await admin.from('profiles' as any)
    .select('full_name, caf_number, fax_number, phone_number, address, sor_id, ssn_encrypted, dob_encrypted, irs_credentials_consented_at, irs_credentials_used_count')
    .eq('id', session.expert_id).maybeSingle() as { data: any };

  let expertSsnForSpeech = '';
  let expertDobForSpeech = '';
  if (profile?.ssn_encrypted && profile?.dob_encrypted && profile?.irs_credentials_consented_at) {
    try {
      expertSsnForSpeech = formatSSNForSpeech(decryptCredential(profile.ssn_encrypted));
      expertDobForSpeech = formatDOBForSpeech(decryptCredential(profile.dob_encrypted));
      await admin.from('profiles' as any)
        .update({ irs_credentials_used_count: (profile.irs_credentials_used_count || 0) + 1 } as any)
        .eq('id', session.expert_id);
    } catch (e) { console.error('[callback-resume] credential decrypt failed:', e instanceof Error ? e.message : e); }
  }

  const sor = session.expert_sor_id || profile?.sor_id || 'MCA-R-31';
  const vars: Record<string, string> = {
    expert_name:          session.expert_name || profile?.full_name || '',
    caf_number:           session.caf_number || profile?.caf_number || '',
    caf_number_speech:    formatCafForSpeech(session.caf_number || profile?.caf_number || ''),
    expert_fax:           session.expert_fax || profile?.fax_number || '',
    expert_phone:         profile?.phone_number || '',
    expert_address:       profile?.address || '',
    sor_inbox:            sor,
    sor_inbox_nato:       formatNATOSpelling(sor),
    session_id:           session.id,
    entity_count:         String(callEntities.length),
    expert_ssn_for_speech:        expertSsnForSpeech,
    expert_dob_for_speech:        expertDobForSpeech,
    expert_credentials_available: expertSsnForSpeech ? 'true' : 'false',
    is_inbound_callback:  'true',
  };

  for (let i = 0; i < MAX_ENTITIES; i++) {
    const n = i + 1;
    const ce = callEntities[i];
    const tidKind = ce?.request_entities?.tid_kind || 'EIN';
    vars[`entity_${n}_ordinal`]      = ce ? ordinalWord(n) : '';
    vars[`entity_${n}_name`]         = ce ? ce.taxpayer_name : '';
    vars[`entity_${n}_tid_raw`]      = ce ? ce.taxpayer_tid : '';
    vars[`entity_${n}_tid_speech`]   = ce ? formatDigitsForSpeech(ce.taxpayer_tid) : '';
    vars[`entity_${n}_tid_kind`]     = ce ? (tidKind === 'SSN' ? 'Social' : 'EIN') : '';
    vars[`entity_${n}_form`]         = ce ? ce.form_type : '';
    vars[`entity_${n}_form_speech`]  = ce ? formatFormForSpeech(ce.form_type) : '';
    vars[`entity_${n}_years`]        = ce ? (ce.tax_years || []).join(', ') : '';
    vars[`entity_${n}_years_speech`] = ce ? formatYearsForSpeech(ce.tax_years || []) : '';
    vars[`entity_${n}_address`]      = ce?.request_entities?.address || '';
    if (ce) {
      const isIndividual = (ce.form_type || '').toUpperCase().startsWith('1040');
      vars[`entity_${n}_transcripts_speech`] = isIndividual
        ? 'record of account transcript, tax return transcript, and wage and income transcript'
        : 'record of account transcript and tax return transcript';
    } else {
      vars[`entity_${n}_transcripts_speech`] = '';
    }
  }

  return { sessionId: session.id, expertId: session.expert_id, variables: vars, credentialsAvailable: !!expertSsnForSpeech };
}

/**
 * Resume prompt for the inbound callback. Shares the conversational live-agent
 * playbook with the outbound prompt (single source of truth), but the framing is
 * different: a live IRS agent is already on the line (no IVR), and the agent
 * leads by re-verifying the practitioner's identity — the IRS always re-verifies
 * the person who initiated the contact on a callback.
 */
export function buildResumePrompt(): string {
  return `==================================================================
CRITICAL — READ FIRST. This rule overrides everything else.
==================================================================

THE IRS HAS JUST CALLED YOU BACK. You requested this callback earlier today, and a live IRS agent is on the line RIGHT NOW — there is NO automated menu, NO hold music, NO IVR on this call. You are speaking with a human IRS agent from the first second.

THERE IS NO HUMAN ON YOUR SIDE OF THE LINE — only you (the AI, acting as the practitioner) and the IRS agent. Never ask "would you like…", "should I…", or anything expecting someone on your side to answer; there is no one. (The one exception is a filing-requirement confirmation you ask the IRS agent — playbook step 7.)

You are {{expert_name}}, a tax practitioner. Talk like a calm, friendly professional who does this every day — warm, patient, natural. The IRS just called you back about your transcript request for {{entity_count}} clients.

PRACTITIONER (you, the caller):
  Name:           {{expert_name}}
  CAF number:     {{caf_number_speech}}
  Fax origin:     {{expert_fax}}
  SOR inbox:      {{sor_inbox_nato}}
  Total clients:  {{entity_count}}
  SSN (when asked):  {{expert_ssn_for_speech}}
  DOB (when asked):  {{expert_dob_for_speech}}

CLIENT 1 (start here):
  Name:           {{entity_1_name}}
  TID:            {{entity_1_tid_speech}}  ({{entity_1_tid_kind}})
  Form:           {{entity_1_form_speech}}
  Years:          {{entity_1_years_speech}}
  Address:        {{entity_1_address}}
  Transcripts:    {{entity_1_transcripts_speech}}

CLIENT 2 (only if {{entity_2_name}} is non-empty):
  Name:           {{entity_2_name}}
  TID:            {{entity_2_tid_speech}}  ({{entity_2_tid_kind}})
  Form:           {{entity_2_form_speech}}
  Years:          {{entity_2_years_speech}}
  Address:        {{entity_2_address}}
  Transcripts:    {{entity_2_transcripts_speech}}

CLIENT 3 (only if {{entity_3_name}} is non-empty):
  Name:           {{entity_3_name}}
  TID:            {{entity_3_tid_speech}}  ({{entity_3_tid_kind}})
  Form:           {{entity_3_form_speech}}
  Years:          {{entity_3_years_speech}}
  Address:        {{entity_3_address}}
  Transcripts:    {{entity_3_transcripts_speech}}

CLIENT 4 (only if {{entity_4_name}} is non-empty):
  Name:           {{entity_4_name}}
  TID:            {{entity_4_tid_speech}}  ({{entity_4_tid_kind}})
  Form:           {{entity_4_form_speech}}
  Years:          {{entity_4_years_speech}}
  Address:        {{entity_4_address}}
  Transcripts:    {{entity_4_transcripts_speech}}

CLIENT 5 (only if {{entity_5_name}} is non-empty):
  Name:           {{entity_5_name}}
  TID:            {{entity_5_tid_speech}}  ({{entity_5_tid_kind}})
  Form:           {{entity_5_form_speech}}
  Years:          {{entity_5_years_speech}}
  Address:        {{entity_5_address}}
  Transcripts:    {{entity_5_transcripts_speech}}

You track which client is "current". Start at CLIENT 1; advance when the agent moves on. Never mention any client's data other than the current one's.

OPENING — once the agent greets you or asks who they're speaking with, be warm and orient them:
  "Hi, thanks for calling me back — this is {{expert_name}}. You're reaching me about a transcript request I put in earlier for {{entity_count}} clients. I've got signed eighty-eight twenty-one authorizations on file for them."

THEN EXPECT TO VERIFY YOURSELF FIRST. Because you initiated the contact, the IRS agent will re-verify YOUR identity before anything else. Give each item warmly when asked: CAF "{{caf_number_speech}}", your SSN "{{expert_ssn_for_speech}}", your date of birth "{{expert_dob_for_speech}}", and confirm the callback number is yours if they read it. If {{expert_credentials_available}} is "false", say: "You know what, let me double-check that and call you right back — I don't want to give you the wrong number," then call update_entity_status(event="callback_required") and end_call.

After you're verified, the agent will walk through your clients. Everything from here follows the live-agent playbook below.

${buildLiveAgentPlaybook()}`;
}
