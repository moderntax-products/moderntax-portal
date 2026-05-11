/**
 * Pull both of today's Retell call detail records via the Retell SDK
 * directly. Bypasses our DB so we see what Retell actually captured
 * vs. what we wrote into irs_call_sessions.
 *
 * Calls to inspect:
 *   - call_c1a856e31505b965a74eb52f46d (12:12 PM, our session
 *     eec4a94a, marked completed but actually overflow-rejected)
 *   - call_a56040d6b3c9b1186a805701fa2 (12:22 PM, our session
 *     aa642656, cancelled at 33-min mark, empty transcript in DB)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { getCall } from '@/lib/retell';

async function inspect(callId: string, label: string) {
  console.log(`\n=== ${label}: ${callId} ===\n`);
  try {
    const c = await getCall(callId);
    console.log(`call_status:          ${c.call_status}`);
    console.log(`duration_ms:          ${c.duration_ms}`);
    console.log(`start_timestamp:      ${c.start_timestamp ? new Date(c.start_timestamp).toISOString() : '—'}`);
    console.log(`end_timestamp:        ${c.end_timestamp ? new Date(c.end_timestamp).toISOString() : '—'}`);
    console.log(`disconnection_reason: ${c.disconnection_reason || '—'}`);
    console.log(`from_number:          ${(c as any).from_number || '—'}`);
    console.log(`to_number:            ${(c as any).to_number || '—'}`);
    console.log(`recording_url:        ${c.recording_url ? '(present)' : '—'}`);

    const tx = c.transcript || '';
    console.log(`\nTranscript (${tx.length} chars):\n`);
    console.log(tx.slice(0, 5000));
    if (tx.length > 5000) console.log('\n... [truncated]');

    // Look for the wait-time decision tools firing
    const obj = c as any;
    if (obj.call_analysis) {
      console.log('\ncall_analysis:', JSON.stringify(obj.call_analysis, null, 2).slice(0, 1500));
    }
    // Tool call events (Retell records function call invocations)
    if (obj.tool_calls || obj.transcript_object || obj.transcript_with_tool_calls) {
      const events = obj.tool_calls || obj.transcript_with_tool_calls || obj.transcript_object;
      console.log(`\nTool/transcript events: ${Array.isArray(events) ? events.length : '?'}`);
      if (Array.isArray(events)) {
        // Just the tool-call invocations
        const toolEvents = events.filter((e: any) => e?.role === 'tool_call_invocation' || e?.tool_call_id || e?.function);
        console.log(`  (${toolEvents.length} tool invocations)`);
        toolEvents.slice(0, 30).forEach((e: any, i: number) => {
          console.log(`  ${i}. ${JSON.stringify(e).slice(0, 300)}`);
        });
      }
    }
  } catch (err) {
    console.error(`Failed for ${callId}:`, err instanceof Error ? err.message : err);
  }
}

async function main() {
  await inspect('call_c1a856e31505b965a74eb52f46d', 'CALL 1 (12:12 PM, overflow-rejected, marked completed)');
  await inspect('call_a56040d6b3c9b1186a805701fa2', 'CALL 2 (12:22 PM, cancelled at 33 min)');
}
main().catch(e => { console.error(e); process.exit(1); });
