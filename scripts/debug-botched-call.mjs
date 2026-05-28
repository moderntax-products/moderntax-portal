#!/usr/bin/env node
/**
 * Pull the recent Retell call(s) for the requeued 922 Kilburn entity
 * so we can see exactly what burned 163 minutes / $14.66.
 *
 * Two sources:
 *  1. our irs_call_sessions DB table (for ours-side metadata + linkage)
 *  2. Retell list-calls / get-call (for the actual transcript + reason)
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const env = Object.fromEntries(
  envText.split('\n')
    .filter(l => l && !l.trim().startsWith('#') && l.includes('='))
    .map(l => {
      const eq = l.indexOf('=');
      return [l.slice(0, eq).trim(), l.slice(eq + 1).trim().replace(/^["']|["']$/g, '')];
    })
);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const RETELL_KEY = env.RETELL_API_KEY;
const ENTITY_ID = '743a3929-71c3-433b-be88-af6e27998f2e'; // 922 KILBURN OPERATIONS LLC

// 1) Pull our DB session rows for this entity (newest first)
const { data: ourSessions } = await sb
  .from('irs_call_sessions')
  .select('id, retell_call_id, bland_call_id, started_at, ended_at, status, outcome, expert_id, duration_seconds, total_cost_cents, raw_metadata')
  .or(`entity_id.eq.${ENTITY_ID},entity_ids.cs.{${ENTITY_ID}}`)
  .order('started_at', { ascending: false })
  .limit(5);
console.log('Our irs_call_sessions for 922 Kilburn:', ourSessions?.length || 0);
for (const s of (ourSessions || [])) {
  console.log(`  · session=${s.id}`);
  console.log(`    retell_call_id=${s.retell_call_id || '—'}`);
  console.log(`    started=${s.started_at} ended=${s.ended_at}`);
  console.log(`    status=${s.status} outcome=${s.outcome}`);
  console.log(`    duration_seconds=${s.duration_seconds} cost_cents=${s.total_cost_cents}`);
}

// Fallback: maybe it's tracked differently — pull by recency
if (!ourSessions?.length) {
  console.log('\nFallback: pulling 5 most-recent irs_call_sessions');
  const { data: recent } = await sb
    .from('irs_call_sessions')
    .select('id, retell_call_id, started_at, ended_at, status, outcome, duration_seconds, total_cost_cents, entity_id, entity_ids, raw_metadata')
    .order('started_at', { ascending: false })
    .limit(5);
  for (const s of (recent || [])) {
    console.log(`  · session=${s.id} retell=${s.retell_call_id} status=${s.status} outcome=${s.outcome} duration=${s.duration_seconds}s cost=${s.total_cost_cents}c entity=${s.entity_id} entities=${JSON.stringify(s.entity_ids)}`);
  }
}

// 2) Retell — list recent calls, find the one matching ~163 min today
console.log('\nFetching Retell recent calls…');
const listRes = await fetch('https://api.retellai.com/v2/list-calls', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${RETELL_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ limit: 10 }),
});
if (!listRes.ok) {
  console.error('Retell list-calls', listRes.status, await listRes.text());
  process.exit(1);
}
const calls = await listRes.json();
const recent = calls.filter(c => (c.duration_ms || 0) > 60_000).slice(0, 5);
console.log(`Recent calls (>60s): ${recent.length}`);
for (const c of recent) {
  const dur = Math.round((c.duration_ms || 0) / 1000);
  const startStr = c.start_timestamp ? new Date(c.start_timestamp).toISOString() : '—';
  console.log(`  · ${c.call_id} · ${startStr} · ${dur}s · status=${c.call_status} · reason=${c.disconnection_reason || '—'}`);
}

// 3) Pick the 163-minute call (within 5 min tolerance) and dump details
const target = recent.find(c => {
  const min = (c.duration_ms || 0) / 60_000;
  return min > 150 && min < 200;
}) || recent[0];
if (!target) { console.log('No long call found.'); process.exit(0); }

console.log(`\nDetail for ${target.call_id} (${Math.round(target.duration_ms/1000/60)} min):`);
console.log('  status:', target.call_status);
console.log('  disconnect_reason:', target.disconnection_reason);
console.log('  start:', new Date(target.start_timestamp).toISOString());
console.log('  end:', target.end_timestamp ? new Date(target.end_timestamp).toISOString() : '—');
if (target.metadata) console.log('  metadata:', JSON.stringify(target.metadata).slice(0, 300));
console.log('  recording_url:', target.recording_url || '—');
console.log('  agent_id:', target.agent_id);
console.log('  llm_id (response_engine):', JSON.stringify(target.response_engine));

// Pull the FULL transcript via get-call
const getRes = await fetch(`https://api.retellai.com/v2/get-call/${target.call_id}`, {
  headers: { 'Authorization': `Bearer ${RETELL_KEY}` },
});
const full = await getRes.json();
const transcript = full.transcript || '';
console.log(`\n=== Transcript (${transcript.length} chars) ===`);
// Save full transcript for analysis
const fname = `/tmp/retell-call-${target.call_id}.txt`;
const fs = await import('node:fs');
fs.writeFileSync(fname, transcript);
console.log(`Saved to ${fname}`);
console.log('\nFirst 1500 chars:');
console.log(transcript.slice(0, 1500));
console.log('\n... last 2000 chars:');
console.log(transcript.slice(-2000));

// Check call_analysis for sentiment / structured info
if (full.call_analysis) {
  console.log('\nCall analysis:');
  console.log(JSON.stringify(full.call_analysis, null, 2));
}
