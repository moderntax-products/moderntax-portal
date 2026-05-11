import { config } from 'dotenv';
config({ path: '.env.local' });
import { getCall } from '@/lib/retell';

async function main() {
  const c = await getCall('call_a56040d6b3c9b1186a805701fa2');
  console.log(`status:               ${c.call_status}`);
  console.log(`duration_ms:          ${c.duration_ms}`);
  console.log(`start_timestamp:      ${c.start_timestamp ? new Date(c.start_timestamp).toISOString() : '—'}`);
  console.log(`end_timestamp:        ${c.end_timestamp ? new Date(c.end_timestamp).toISOString() : '—'}`);
  console.log(`disconnection_reason: ${c.disconnection_reason || '—'}`);
  if (c.duration_ms) {
    console.log(`duration:             ${Math.round(c.duration_ms / 1000 / 60)} min`);
  } else if (c.start_timestamp) {
    const elapsed = Date.now() - c.start_timestamp;
    console.log(`elapsed since start:  ${Math.round(elapsed / 1000 / 60)} min`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
