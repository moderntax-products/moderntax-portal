/**
 * Pull the full Retell call object for a given call_id — gets us the
 * recording URL, the line-by-line transcript with timestamps, every
 * DTMF press, every agent turn, and any post-call analysis Retell
 * generated.
 *
 * Use this to inspect why a call ended in overflow_rejected — listen
 * to what IRS said RIGHT BEFORE the rejection at the 150s mark, and
 * see exactly when/what our agent pressed.
 *
 * Usage:
 *   node scripts/inspect-retell-call.mjs <call_id>
 */

import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const callId = process.argv[2] || 'call_06084f2f2ae3934949d7fe0424d'; // last NY-ET attempt
const apiKey = process.env.RETELL_API_KEY;
if (!apiKey) {
  console.error('RETELL_API_KEY not set in .env.local');
  process.exit(1);
}

const res = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, {
  headers: { 'Authorization': `Bearer ${apiKey}` },
});
if (!res.ok) {
  console.error(`Retell API ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const call = await res.json();

console.log(`\n${'═'.repeat(80)}`);
console.log(`Retell Call ${callId}`);
console.log(`${'═'.repeat(80)}\n`);
console.log(`From:           ${call.from_number}`);
console.log(`To:             ${call.to_number}`);
console.log(`Status:         ${call.call_status}`);
console.log(`Disconnect:     ${call.disconnection_reason}`);
console.log(`Started:        ${new Date(call.start_timestamp).toISOString()}`);
console.log(`Ended:          ${call.end_timestamp ? new Date(call.end_timestamp).toISOString() : '—'}`);
console.log(`Duration:       ${call.duration_ms ? (call.duration_ms / 1000).toFixed(1) + 's' : '—'}`);
console.log(`Recording URL:  ${call.recording_url || '(none — may not be ready yet)'}`);
console.log(`Public log:     ${call.public_log_url || '(none)'}`);
console.log(`Dashboard:      https://app.retellai.com/calls/${callId}\n`);

if (call.call_analysis) {
  console.log(`AI summary:     ${call.call_analysis.call_summary || '—'}`);
  console.log(`User sentiment: ${call.call_analysis.user_sentiment || '—'}`);
  console.log(`Call successful: ${call.call_analysis.call_successful}`);
  console.log();
}

if (call.transcript_object && call.transcript_object.length > 0) {
  console.log(`Transcript (${call.transcript_object.length} turns):`);
  console.log(`${'─'.repeat(80)}`);
  for (const turn of call.transcript_object) {
    const ts = turn.words?.[0]?.start ? `[${turn.words[0].start.toFixed(1)}s]` : '[?]';
    const role = turn.role === 'agent' ? 'AGENT' : turn.role === 'user' ? 'IRS  ' : turn.role.toUpperCase().padEnd(5);
    const content = (turn.content || '').slice(0, 200);
    console.log(`${ts.padEnd(8)} ${role}: ${content}`);
  }
} else if (call.transcript) {
  console.log(`Transcript (raw):`);
  console.log(`${'─'.repeat(80)}`);
  console.log(call.transcript.slice(0, 4000));
} else {
  console.log(`(No transcript yet — call may still be processing)`);
}

if (call.tool_calls && call.tool_calls.length > 0) {
  console.log(`\nTool calls (${call.tool_calls.length}):`);
  for (const t of call.tool_calls) {
    console.log(`  · ${t.name}(${JSON.stringify(t.arguments || {}).slice(0, 100)})`);
  }
}
