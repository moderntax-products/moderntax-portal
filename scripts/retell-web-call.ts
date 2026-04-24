/**
 * Create a Retell web call so we can validate the agent + prompt + tools
 * in-browser before paying for a phone number.
 *
 * Usage:
 *   npx tsx scripts/retell-web-call.ts
 *
 * Outputs an access_token. Paste it into the Retell Web Call tester at
 * https://docs.retellai.com/integrations/web-call (their SDK) or any
 * browser page using their web SDK. Or Matt can open:
 *   https://dashboard.retellai.com/agents/{AGENT_ID}
 * and click "Test in browser" — same effect.
 *
 * Web calls are free (counts against the standard per-minute credit), so
 * this lets us burn ~10-20 cents to verify the full prompt end-to-end
 * before committing to PSTN.
 */
import * as fs from 'fs';
for (const fname of ['.env.local']) {
  if (!fs.existsSync(fname)) continue;
  const envFile = fs.readFileSync(fname, 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function main() {
  const AGENT_ID = process.env.RETELL_IRS_AGENT_ID;
  if (!AGENT_ID) throw new Error('RETELL_IRS_AGENT_ID not set');

  const res = await fetch('https://api.retellai.com/v2/create-web-call', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.RETELL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      agent_id: AGENT_ID,
      retell_llm_dynamic_variables: {
        expert_name: 'Matthew Parker',
        caf_number: '0316-30210R',
        expert_fax: '415-900-4436',
        expert_phone: '704-277-5862',
        expert_address: '2 Embarcadero, 8th Floor, San Francisco, CA 94111',
        sor_inbox: 'M-C-A-R-3-1',
        callback_phone: '7042775862',
        session_id: 'test-web-call-' + Date.now(),
        entity_count: '2',
        entity_json: JSON.stringify([
          {
            name: 'Paradise Car Wash Inc',
            tid: '20-2444592',
            tidKind: 'EIN',
            formType: '1120S',
            years: ['2022', '2023', '2024'],
            address: '2937 Veneman Ave Ste A201, Modesto, CA 95356',
          },
          {
            name: 'Laxmi Hospitality LLC',
            tid: '82-3929860',
            tidKind: 'EIN',
            formType: '1120S',
            years: ['2022', '2023', '2024'],
          },
        ]),
      },
      metadata: { test: true, purpose: 'web-call-validation' },
    }),
  });

  if (!res.ok) {
    console.error('FAIL status:', res.status);
    console.error(await res.text());
    process.exit(1);
  }
  const data = await res.json();
  console.log('call_id:      ', data.call_id);
  console.log('access_token: ', data.access_token);
  console.log('\nTest the call in-browser:');
  console.log(`  https://dashboard.retellai.com/agents/${AGENT_ID}`);
  console.log('  → click "Test in browser" (uses this agent config directly)');
  console.log('\nOr inspect the call afterward:');
  console.log(`  curl -H "Authorization: Bearer $RETELL_API_KEY" https://api.retellai.com/v2/get-call/${data.call_id} | jq`);
}

main().catch(err => { console.error(err); process.exit(1); });
