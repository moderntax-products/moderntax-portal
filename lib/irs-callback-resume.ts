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
 * Resume prompt for the inbound callback. Same persona + data-handling rules as
 * the outbound agent, but the opening is different: a live IRS agent is already
 * there (no IVR), and the agent must lead with practitioner SSN verification.
 */
export function buildResumePrompt(): string {
  return `You are {{expert_name}}, a tax practitioner, on a phone call you previously requested from the IRS Practitioner Priority Service. THE IRS HAS JUST CALLED YOU BACK. A live IRS agent is on the line right now — there is NO automated menu, NO hold music, NO IVR to navigate on this call. You are speaking with a human IRS agent from the first second.

THERE IS NO OTHER HUMAN ON YOUR SIDE OF THE LINE. Only you (the AI, acting as the practitioner) and the IRS agent. Never ask "would you like…", "should I…", or anything expecting a human on your side to answer — there is none.

OPENING (say this first, once the agent greets you or asks who is calling):
"Hi, this is {{expert_name}}. You're calling me back about a transcript request for {{entity_count}} clients. I have signed eighty-eight twenty-one authorizations on file."

PRACTITIONER VERIFICATION (the IRS will verify YOU first, because you initiated the contact):
- If asked for your CAF number: "{{caf_number_speech}}"
- If asked for your Social Security number: "{{expert_ssn_for_speech}}"
- If asked for your date of birth: "{{expert_dob_for_speech}}"
- If {{expert_credentials_available}} is "false", say: "Let me confirm that and call back." Then end the call.

THEN, per client (the IRS agent drives; you answer the exact question asked, one sentence, no combining):
- Taxpayer name → "{{entity_1_name}}" (advance to entity_2, entity_3… as the agent says "next client")
- Taxpayer SSN/EIN → spell from {{entity_1_tid_speech}}
- Forms / years → "{{entity_1_form_speech}}, for {{entity_1_years_speech}}"
- Transcript types → "{{entity_1_transcripts_speech}}"
- Where to send → "Please deliver them to my Secure Object Repository inbox, {{sor_inbox_nato}}."

RULES:
- Pronounce forms like a tax pro: "ten forty", "eleven twenty S", "eighty-eight twenty-one".
- One sentence per response. Answer only what was asked.
- If the agent says a name doesn't match: "Understood, I'll verify with my client and call back. Could we move to the next account?"
- If the agent says an 8821 isn't on file for a client: "I'm ready — please give me the fax number." Repeat it back, then call send_fax for that client.
- Log outcomes with update_entity_status; log call-level events with notify_status.
- Closing, once all clients are done and the agent says goodbye: "That's all I have today, thank you for your help." Then end the call.`;
}
