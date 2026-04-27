/**
 * One-time Retell AI provisioning for IRS PPS calls.
 *
 * Idempotent-ish: on re-run, updates the existing LLM / Agent instead of
 * creating a duplicate (matched by the names "ModernTax IRS PPS LLM" /
 * "ModernTax IRS PPS Agent").
 *
 * After this script runs, drop the returned IDs into env:
 *   RETELL_IRS_LLM_ID
 *   RETELL_IRS_AGENT_ID
 *   RETELL_IRS_FROM_NUMBER  (provision separately in Retell dashboard — $2/mo per number)
 *
 * Then flip CALL_PROVIDER=retell and the voice-provider router uses it.
 *
 * Usage: npx tsx scripts/retell-setup.ts
 */
import * as fs from 'fs';
for (const fname of ['.env.local', '.env.vercel-prod']) {
  if (!fs.existsSync(fname)) continue;
  const envFile = fs.readFileSync(fname, 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const APP_URL = 'https://portal.moderntax.io';
const CALLBACK_PHONE_DEFAULT = '+17042775862'; // Matt's cell — will be overridden per call by dynamic var if different

import {
  createLlm,
  updateLlm,
  listLlms,
  createAgent,
  updateAgent,
  listAgents,
  listPhoneNumbers,
  buildIrsPpsPrompt,
  buildToolsForIrsPps,
} from '../lib/retell';

const LLM_NAME  = 'ModernTax IRS PPS LLM';
const AGENT_NAME = 'ModernTax IRS PPS Agent';

async function main() {
  if (!process.env.RETELL_API_KEY) throw new Error('RETELL_API_KEY not set in env');

  // 1. LLM: create or update
  console.log('→ Building IRS PPS prompt and tools…');
  const prompt = buildIrsPpsPrompt();
  const tools = buildToolsForIrsPps(APP_URL, process.env.BLAND_WEBHOOK_SECRET || '', CALLBACK_PHONE_DEFAULT);

  const existingLlms = await listLlms();
  let llmId: string;
  const existingLlm = existingLlms.find((l: any) => l.general_prompt?.includes('ModernTax IRS PPS') || l.llm_id === process.env.RETELL_IRS_LLM_ID);
  if (existingLlm) {
    console.log(`→ Updating existing LLM ${existingLlm.llm_id}`);
    const updated = await updateLlm(existingLlm.llm_id, {
      model: 'gpt-4.1',
      general_prompt: prompt,
      general_tools: tools,
      begin_message: '',
    });
    llmId = updated.llm_id;
  } else {
    console.log('→ Creating new LLM');
    const created = await createLlm({
      model: 'gpt-4.1',
      general_prompt: prompt,
      general_tools: tools,
      begin_message: '', // AI waits for IRS IVR before speaking
    });
    llmId = created.llm_id;
  }
  console.log(`   LLM id: ${llmId}`);

  // 2. Agent: create or update
  const existingAgents = await listAgents();
  const existingAgent = existingAgents.find(a => a.agent_name === AGENT_NAME);
  let agentId: string;
  const agentConfig = {
    agent_name: AGENT_NAME,
    voice_id: '11labs-Adrian',                 // clean US male practitioner voice
    voice_temperature: 0.5,                    // lower than before for a flatter, more "professional caller" delivery
    voice_speed: 0.95,                         // slightly slow — IRS agents preferred this in 4/24 test
    responsiveness: 0.95,                      // raised — terse responder needs to react fast to each question
    interruption_sensitivity: 0.5,             // lowered — IRS agents pause mid-question; we don't want false interruptions
    enable_backchannel: false,                 // never "uh-huh" the IRS — unprofessional
    language: 'en-US',
    response_engine: { type: 'retell-llm' as const, llm_id: llmId },
    max_call_duration_ms: 60 * 60 * 1000,      // 60 min — room for fax waits
    // Pronunciation: CAF alphanumerics + "1040" etc. should be read naturally.
    pronunciation_dictionary: [
      { word: 'EIN',  alphabet: 'ipa' as const, phoneme: 'iː.aɪ.ɛn' },
      { word: 'SSN',  alphabet: 'ipa' as const, phoneme: 'ɛs.ɛs.ɛn' },
      { word: 'CAF',  alphabet: 'ipa' as const, phoneme: 'siː.eɪ.ɛf' },
      { word: '1120S', alphabet: 'ipa' as const, phoneme: 'ɛˈlɛvən ˈtwɛnti ɛs' },
      { word: '1120',  alphabet: 'ipa' as const, phoneme: 'ɛˈlɛvən ˈtwɛnti' },
      { word: '1040',  alphabet: 'ipa' as const, phoneme: 'ˈtɛn ˈfɔːrti' },
      { word: '1065',  alphabet: 'ipa' as const, phoneme: 'ˈtɛn ˈsɪksti faɪv' },
      { word: '941',   alphabet: 'ipa' as const, phoneme: 'naɪn ˈfɔːrti wʌn' },
      { word: '8821',  alphabet: 'ipa' as const, phoneme: 'ˈeɪt ˈeɪti tuː wʌn' },
      { word: 'SOR',   alphabet: 'ipa' as const, phoneme: 'ɛs.oʊ.ɑr' },
    ],
    post_call_analysis_data: [
      { type: 'string',  name: 'outcome_summary',       description: 'One-line summary of what was accomplished' },
      { type: 'string',  name: 'agent_name_captured',   description: 'Name of the IRS agent, if stated' },
      { type: 'string',  name: 'agent_badge_captured',  description: 'IRS agent badge/ID number, if stated' },
      { type: 'number',  name: 'entities_transcripts_requested', description: 'Count of entities where transcripts were successfully requested' },
      { type: 'boolean', name: 'callback_required',     description: 'Whether the agent asked us to verify info and call back' },
      { type: 'string',  name: 'callback_reason',       description: 'If callback_required, why' },
    ],
  };

  if (existingAgent) {
    console.log(`→ Updating existing agent ${existingAgent.agent_id}`);
    const updated = await updateAgent(existingAgent.agent_id, agentConfig);
    agentId = updated.agent_id;
  } else {
    console.log('→ Creating new agent');
    const created = await createAgent(agentConfig);
    agentId = created.agent_id;
  }
  console.log(`   Agent id: ${agentId}`);

  // 3. Phone number — Retell won't auto-buy one via API without billing setup;
  // we surface what's provisioned and let the user pick one from the dashboard.
  const phones = await listPhoneNumbers();
  console.log(`\n→ Phone numbers on your Retell account: ${phones.length}`);
  for (const p of phones) {
    console.log(`   ${p.phone_number_pretty || p.phone_number}  outbound_agent=${p.outbound_agent_id || '—'}  nickname=${p.nickname || '—'}`);
  }
  const outboundPhone = phones.find(p => p.outbound_agent_id === agentId) || phones[0];

  console.log('\n=== READY ===');
  console.log('Add these to .env.local and Vercel env:');
  console.log(`  RETELL_IRS_LLM_ID="${llmId}"`);
  console.log(`  RETELL_IRS_AGENT_ID="${agentId}"`);
  if (outboundPhone) {
    console.log(`  RETELL_IRS_FROM_NUMBER="${outboundPhone.phone_number}"`);
    if (outboundPhone.outbound_agent_id !== agentId) {
      console.log(`\n⚠ Assign the agent to the phone number in Retell dashboard:`);
      console.log(`   https://dashboard.retellai.com/phone-numbers`);
      console.log(`   Set Outbound Agent = "${AGENT_NAME}"`);
    }
  } else {
    console.log(`\n⚠ No phone numbers provisioned yet.`);
    console.log('   Buy one at https://dashboard.retellai.com/phone-numbers ($2/mo; separate from $10 call credits)');
    console.log('   Then assign Outbound Agent = "' + AGENT_NAME + '"');
    console.log('   Then add RETELL_IRS_FROM_NUMBER="+1XXXXXXXXXX" to env.');
  }
  console.log('\nFinally: set CALL_PROVIDER="retell" in env to route new calls through Retell.');
}

main().catch(err => {
  console.error('FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
