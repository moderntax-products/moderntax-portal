import { config } from 'dotenv';
config({ path: '.env.local' });

const API_KEY = process.env.RETELL_API_KEY!;
const AGENT_ID = process.env.RETELL_IRS_AGENT_ID!;
const LLM_ID = process.env.RETELL_IRS_LLM_ID!;

async function main() {
  console.log(`AGENT_ID = ${AGENT_ID}`);
  console.log(`LLM_ID   = ${LLM_ID}\n`);

  // Get LLM (which holds the prompt)
  const r = await fetch(`https://api.retellai.com/get-retell-llm/${LLM_ID}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!r.ok) { console.log('get LLM failed:', r.status, await r.text()); return; }
  const llm = await r.json();
  const prompt: string = llm.general_prompt || '';
  console.log(`LLM general_prompt length: ${prompt.length} chars`);

  // Check for our key wait-time-decision-tree phrases
  const checks = [
    'wait_too_long_no_callback',
    'DECISION TREE',
    'greater than 15 minutes',
    'overflow_rejected',
    'PHASE 2 — DECIDE',
    'PHASE 2 — CALLBACK OR HOLD', // the OLD version
  ];
  console.log('\nPrompt content checks:');
  for (const c of checks) {
    const found = prompt.includes(c);
    console.log(`  ${found ? '✓' : '✗'}  contains "${c}"`);
  }

  // Tools — should include notify_status with the wait_too_long enum
  const tools = llm.general_tools || [];
  console.log(`\nTools: ${tools.length}`);
  const notify = tools.find((t: any) => t.name === 'notify_status');
  if (notify) {
    console.log(`  notify_status URL: ${notify.url}`);
    console.log(`  notify_status event enum: ${JSON.stringify(notify.parameters?.properties?.event?.enum)}`);
  } else {
    console.log('  ✗ notify_status tool NOT found');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
