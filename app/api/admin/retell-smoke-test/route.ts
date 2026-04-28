/**
 * Retell PSTN smoke test.
 *
 * POST /api/admin/retell-smoke-test
 *   Body: { to: "+1XXXXXXXXXX" } — admin's cell or any number that's safe
 *                                  to have a 30-sec demo call with.
 *
 * Fires an outbound Retell call using the IRS PPS agent with REAL dynamic
 * variables (pre-formatted for speech, flat, no JSON, no bracketed
 * expressions). The target number will hear the agent open with its
 * IRS-introduction script — proves that interpolation works end-to-end
 * without actually dialing the IRS.
 *
 * Budget: ~$0.30-0.50 depending on how long the recipient stays on the
 * line. Recipient should hang up within 30 sec.
 *
 * Guarded by CRON_SECRET. Admin-session auth is NOT accepted — we don't
 * want a compromised admin account to be able to dial arbitrary numbers
 * from our Retell pool.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { createPhoneCall } from '@/lib/retell';
import { pickFromNumber } from '@/lib/phone-pool';
import {
  decryptCredential,
  formatSSNForSpeech, formatDOBForSpeech,
  formatCafForSpeech, formatDigitsForSpeech,
  formatFormForSpeech, formatYearsForSpeech,
  formatNATOSpelling, ordinalWord,
} from '@/lib/crypto';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const auth = request.headers.get('authorization');
  if (!auth || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({} as any));
  const to: string | undefined = body.to;
  const expertEmail: string = body.expertEmail || 'matthewaparker@icloud.com';
  if (!to || !/^\+1\d{10}$/.test(to)) {
    return NextResponse.json({ error: 'Provide body.to as +1 followed by 10 digits (your cell).' }, { status: 400 });
  }

  const picked = pickFromNumber();
  if (!picked) return NextResponse.json({ error: 'No phone pool entry eligible right now (outside IRS hours across all timezones)' }, { status: 409 });

  const agentId = process.env.RETELL_IRS_AGENT_ID;
  if (!agentId) return NextResponse.json({ error: 'RETELL_IRS_AGENT_ID not configured' }, { status: 500 });

  // Load the expert's stored SSN/DOB (if any) so the smoke test mirrors prod.
  const admin = createAdminClient();
  const list = await admin.auth.admin.listUsers();
  const user = list.data?.users?.find((u: any) => (u.email || '').toLowerCase() === expertEmail.toLowerCase());
  if (!user) return NextResponse.json({ error: `No expert with email ${expertEmail}` }, { status: 404 });

  const { data: profile } = await (admin.from('profiles' as any) as any)
    .select('full_name, caf_number, fax_number, address, phone_number, sor_id, ssn_encrypted, dob_encrypted, irs_credentials_consented_at')
    .eq('id', user.id)
    .single();

  let expertSsnForSpeech = '';
  let expertDobForSpeech = '';
  if (profile?.ssn_encrypted && profile?.dob_encrypted && profile?.irs_credentials_consented_at) {
    try {
      expertSsnForSpeech = formatSSNForSpeech(decryptCredential(profile.ssn_encrypted));
      expertDobForSpeech = formatDOBForSpeech(decryptCredential(profile.dob_encrypted));
    } catch (err) {
      console.error('[smoke-test] decrypt failed:', err);
    }
  }

  // Fake entity — a safe test fixture that looks like a real Centerstone client
  const fakeEntities = [{
    name: 'Paradise Car Wash Inc',
    tid: '202444592',
    tidKind: 'EIN' as const,
    formType: '1120S',
    years: ['2022', '2023', '2024'],
    address: '2937 Veneman Ave Ste A201, Modesto, California 95356',
  }];
  const MAX_ENTITIES = 5;
  const sor = profile?.sor_id || 'MCA-R-31';

  const vars: Record<string, string> = {
    expert_name: profile?.full_name || 'Matthew Parker',
    caf_number: profile?.caf_number || '1234-56789R',
    caf_number_speech: formatCafForSpeech(profile?.caf_number || '1234-56789R'),
    expert_fax: profile?.fax_number || '',
    expert_fax_speech: formatDigitsForSpeech((profile?.fax_number || '').slice(0, 3)),
    expert_phone: profile?.phone_number || '',
    expert_address: profile?.address || '',
    sor_inbox: sor,
    sor_inbox_nato: formatNATOSpelling(sor),
    callback_phone: to.replace(/\D/g, ''),
    session_id: 'smoke-test-' + Date.now(),
    entity_count: '1',
    entity_count_word: ordinalWord(1),
    expert_ssn_for_speech: expertSsnForSpeech,
    expert_dob_for_speech: expertDobForSpeech,
    expert_credentials_available: expertSsnForSpeech ? 'true' : 'false',
    phone_tree_menu_digit: '3',
  };
  for (let i = 0; i < MAX_ENTITIES; i++) {
    const n = i + 1;
    const e = fakeEntities[i];
    vars[`entity_${n}_ordinal`]      = e ? ordinalWord(n) : '';
    vars[`entity_${n}_name`]         = e ? e.name : '';
    vars[`entity_${n}_tid_raw`]      = e ? e.tid : '';
    vars[`entity_${n}_tid_speech`]   = e ? formatDigitsForSpeech(e.tid) : '';
    vars[`entity_${n}_tid_kind`]     = e ? ((e.tidKind as string) === 'SSN' ? 'Social' : 'EIN') : '';
    vars[`entity_${n}_form`]         = e ? e.formType : '';
    vars[`entity_${n}_form_speech`]  = e ? formatFormForSpeech(e.formType) : '';
    vars[`entity_${n}_years`]        = e ? e.years.join(', ') : '';
    vars[`entity_${n}_years_speech`] = e ? formatYearsForSpeech(e.years) : '';
    vars[`entity_${n}_address`]      = e?.address || '';
    if (e) {
      const isIndividual = (e.formType || '').toUpperCase().startsWith('1040');
      vars[`entity_${n}_transcripts_speech`] = isIndividual
        ? 'record of account transcript, tax return transcript, and wage and income transcript'
        : 'record of account transcript and tax return transcript';
    } else {
      vars[`entity_${n}_transcripts_speech`] = '';
    }
  }

  const res = await createPhoneCall({
    from_number: picked.phone,
    to_number: to,
    override_agent_id: agentId,
    retell_llm_dynamic_variables: vars,
    metadata: { smoke_test: true, expert: expertEmail },
  });

  return NextResponse.json({
    success: true,
    call_id: res.call_id,
    from: picked.phone,
    to,
    from_label: picked.label,
    picked_tz: picked.tz,
    sampled_vars: {
      expert_name:            vars.expert_name,
      caf_number_speech:      vars.caf_number_speech,
      entity_1_name:          vars.entity_1_name,
      entity_1_tid_speech:    vars.entity_1_tid_speech,
      entity_1_form_speech:   vars.entity_1_form_speech,
      entity_1_years_speech:  vars.entity_1_years_speech,
      sor_inbox_nato:         vars.sor_inbox_nato,
      credentials_available:  vars.expert_credentials_available,
    },
    instructions:
      'Your phone will ring shortly from ' + picked.phone + '. Answer and pretend to be Ms Smith: ' +
      'say "Thank you for calling PPS, this is Ms Smith, how can I help you?" The agent should open with ' +
      'its real name, CAF, and say "I have 1 account to process today". Hang up within 60 seconds to cap costs.',
  });
}
