/**
 * Force-end the active Retell call call_a56040d6b3c9b1186a805701fa2.
 * Matt clicked "cancel" on our portal but the cancel flow didn't tell
 * Retell to hang up — the call has been running ~35+ min and counting,
 * billing accruing.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { endCall, getCall } from '@/lib/retell';

const CALL_ID = 'call_a56040d6b3c9b1186a805701fa2';

async function main() {
  // Check state first
  console.log('Before:');
  try {
    const before = await getCall(CALL_ID);
    console.log(`  status=${before.call_status}  duration_ms=${before.duration_ms ?? 'n/a'}`);
  } catch (e) { console.log('  getCall failed:', e instanceof Error ? e.message : e); }

  console.log('\nCalling endCall...');
  try {
    await endCall(CALL_ID);
    console.log('  ✓ endCall succeeded');
  } catch (e) {
    console.log('  ✗ endCall failed:', e instanceof Error ? e.message : e);
    return;
  }

  // Brief pause + verify
  await new Promise(r => setTimeout(r, 2000));
  console.log('\nAfter:');
  try {
    const after = await getCall(CALL_ID);
    console.log(`  status=${after.call_status}  duration_ms=${after.duration_ms ?? 'n/a'}`);
    console.log(`  disconnection_reason=${after.disconnection_reason || 'n/a'}`);
  } catch (e) { console.log('  getCall failed:', e instanceof Error ? e.message : e); }
}
main().catch(e => { console.error(e); process.exit(1); });
