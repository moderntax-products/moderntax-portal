/**
 * The /v2/end-call/{call_id} POST returned 404. Retell may have moved
 * the endpoint. Try the documented alternatives in order.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { getCall } from '@/lib/retell';

const CALL_ID = 'call_a56040d6b3c9b1186a805701fa2';
const API_KEY = process.env.RETELL_API_KEY!;
const BASE = 'https://api.retellai.com';

async function tryEndpoint(label: string, init: { url: string; method: string; body?: any }) {
  console.log(`\n→ ${label}: ${init.method} ${init.url}`);
  const res = await fetch(init.url, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  console.log(`   status ${res.status}`);
  const text = await res.text();
  console.log(`   body: ${text.slice(0, 400)}`);
  return res.ok;
}

async function main() {
  // Pre-check
  console.log('Current state:');
  const before = await getCall(CALL_ID);
  console.log(`  status=${before.call_status}  duration_ms=${before.duration_ms ?? '—'}`);
  if (before.call_status !== 'ongoing') {
    console.log('\nCall is no longer ongoing — nothing to terminate.');
    return;
  }

  // Try variants
  const variants = [
    { label: 'POST /v2/calls/{id}/end-call', url: `${BASE}/v2/calls/${CALL_ID}/end-call`, method: 'POST' },
    { label: 'POST /v2/end-call (body call_id)', url: `${BASE}/v2/end-call`, method: 'POST', body: { call_id: CALL_ID } },
    { label: 'DELETE /v2/calls/{id}', url: `${BASE}/v2/calls/${CALL_ID}`, method: 'DELETE' },
    { label: 'POST /v2/calls/{id}', url: `${BASE}/v2/calls/${CALL_ID}`, method: 'POST', body: { action: 'end_call' } },
  ];

  for (const v of variants) {
    const ok = await tryEndpoint(v.label, v);
    if (ok) {
      console.log('\n✓ Worked. Verifying...');
      await new Promise(r => setTimeout(r, 2000));
      const after = await getCall(CALL_ID);
      console.log(`  status=${after.call_status}  duration_ms=${after.duration_ms ?? '—'}`);
      return;
    }
  }

  console.log('\n✗ None worked. Call still ongoing.');
}
main().catch(e => { console.error(e); process.exit(1); });
