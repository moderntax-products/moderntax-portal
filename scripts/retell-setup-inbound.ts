/**
 * Provision the Retell INBOUND resume agent for IRS callbacks.
 *
 *   npx -y dotenv-cli -e .env.local -e .env.vercel-prod -- npx tsx scripts/retell-setup-inbound.ts
 *
 * Prints RETELL_IRS_INBOUND_AGENT_ID. Then in Retell, set each callback DID's
 * inbound_agent_id to this agent and its inbound_webhook_url to
 * /api/webhook/retell-inbound (which injects per-session dynamic variables).
 */
import { createLlm, updateLlm, listLlms, createAgent, updateAgent, listAgents, buildToolsForIrsPps } from '../lib/retell';
import { buildResumePrompt } from '../lib/irs-callback-resume';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';
const LLM_TAG = 'ModernTax IRS Callback Resume';
const AGENT_NAME = 'ModernTax IRS Callback Resume';

async function main() {
  if (!process.env.RETELL_API_KEY) throw new Error('RETELL_API_KEY not set');

  const prompt = buildResumePrompt();
  // Same mid-call tools as outbound (send_fax / update_entity_status /
  // notify_status / end_call). The callback DID is per-session, so the static
  // callback-phone arg here is unused on the inbound path.
  const tools = buildToolsForIrsPps(APP_URL, process.env.RETELL_WEBHOOK_SECRET || process.env.BLAND_WEBHOOK_SECRET || '', '');

  const llms = await listLlms();
  const existingLlm = llms.find((l: any) => l.general_prompt?.includes('THE IRS HAS JUST CALLED YOU BACK') || l.llm_id === process.env.RETELL_IRS_INBOUND_LLM_ID);
  let llmId: string;
  if (existingLlm) {
    llmId = (await updateLlm(existingLlm.llm_id, { model: 'gpt-4.1', general_prompt: prompt, general_tools: tools, begin_message: '' })).llm_id;
    console.log(`→ updated inbound LLM ${llmId}`);
  } else {
    llmId = (await createLlm({ model: 'gpt-4.1', general_prompt: prompt, general_tools: tools, begin_message: '' })).llm_id;
    console.log(`→ created inbound LLM ${llmId}`);
  }

  const agents = await listAgents();
  const existing = agents.find(a => a.agent_name === AGENT_NAME);
  const cfg = {
    agent_name: AGENT_NAME,
    voice_id: '11labs-Adrian',
    voice_temperature: 0.5,
    voice_speed: 0.95,
    responsiveness: 0.95,
    interruption_sensitivity: 0.5,
    enable_backchannel: false,
    language: 'en-US' as const,
    response_engine: { type: 'retell-llm' as const, llm_id: llmId },
    max_call_duration_ms: 90 * 60 * 1000,
    post_call_analysis_data: [
      { type: 'string' as const, name: 'outcome_summary', description: 'One-line summary of what was accomplished' },
      { type: 'string' as const, name: 'agent_name_captured', description: 'IRS agent name, if stated' },
      { type: 'number' as const, name: 'entities_transcripts_requested', description: 'Count of entities transcripts were requested for' },
    ],
  };
  let agentId: string;
  if (existing) { agentId = (await updateAgent(existing.agent_id, cfg)).agent_id; console.log(`→ updated inbound agent ${agentId}`); }
  else { agentId = (await createAgent(cfg)).agent_id; console.log(`→ created inbound agent ${agentId}`); }

  console.log(`\nAdd to env:\n  RETELL_IRS_INBOUND_AGENT_ID="${agentId}"`);
  console.log(`  RETELL_IRS_INBOUND_LLM_ID="${llmId}"`);
  console.log(`\nThen in Retell, for each callback DID set inbound_agent_id=${agentId} and inbound_webhook_url=${APP_URL}/api/webhook/retell-inbound`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
