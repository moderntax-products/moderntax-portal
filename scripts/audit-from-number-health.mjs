#!/usr/bin/env node
/**
 * Audit each Retell outbound from-number's success rate against the IRS PPS
 * line over the last N days. Goal: identify any number being flagged by the
 * IRS's robocall mitigation so we can retire it and provision a fresh one.
 *
 * Outcomes per call:
 *   - dial_no_answer        — IRS line never picked up (likely blocked)
 *   - early_user_hangup     — IRS picked up but hung up within 180s
 *                             (probably the IVR rejecting the call or
 *                             auto-disconnect before agent answered)
 *   - long_call             — call lasted >180s (got to IVR + hold loop)
 *   - agent_hangup          — our AI ended the call cleanly
 *   - other / unknown
 *
 * For each from-number, report: total, success_rate (long_call /
 * total), no_answer_rate, early_hangup_rate. Flag any number where
 * no_answer_rate + early_hangup_rate > 60% over the last 7 days as a
 * candidate for retirement.
 */

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

const RETELL_KEY = env.RETELL_API_KEY;
const DAYS_BACK = parseInt(process.argv[2] || '7', 10);
const SINCE = Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000;

// 1) List ALL recent calls (Retell paginates; we may need multiple requests)
let allCalls = [];
let cursor = null;
while (true) {
  const body = { limit: 100, sort_order: 'descending' };
  if (cursor) body.pagination_key = cursor;
  const r = await fetch('https://api.retellai.com/v2/list-calls', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RETELL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { console.error('list-calls', r.status, await r.text()); process.exit(1); }
  const page = await r.json();
  if (!page.length) break;
  // Stop once we cross the SINCE boundary
  for (const c of page) {
    if (!c.start_timestamp || c.start_timestamp < SINCE) {
      cursor = null;
      break;
    }
    allCalls.push(c);
  }
  if (page.length < 100 || page[page.length - 1].start_timestamp < SINCE) break;
  cursor = page[page.length - 1].call_id;
}
console.log(`Pulled ${allCalls.length} calls in the last ${DAYS_BACK} days.\n`);

// 2) Need from_number per call — list-calls includes it via to_number/from_number
//    if they exist on the call shape. Fall back to get-call if missing.
async function ensureFromNumber(c) {
  if (c.from_number) return c.from_number;
  const r = await fetch(`https://api.retellai.com/v2/get-call/${c.call_id}`, {
    headers: { 'Authorization': `Bearer ${RETELL_KEY}` },
  });
  if (!r.ok) return null;
  const full = await r.json();
  return full.from_number || null;
}

// Fetch from_number for any call missing it (parallelize in batches of 8)
const needLookup = allCalls.filter(c => !c.from_number);
console.log(`Resolving from_number for ${needLookup.length} calls…`);
const BATCH = 8;
for (let i = 0; i < needLookup.length; i += BATCH) {
  const batch = needLookup.slice(i, i + BATCH);
  const nums = await Promise.all(batch.map(ensureFromNumber));
  for (let j = 0; j < batch.length; j++) batch[j].from_number = nums[j];
}

// 3) Bucket each call by outcome
function classify(c) {
  const dur = (c.duration_ms || 0) / 1000;
  const reason = c.disconnection_reason || '';
  if (c.call_status === 'not_connected' || reason === 'dial_no_answer') return 'dial_no_answer';
  if (reason === 'dial_busy' || reason === 'dial_failed' || reason === 'dial_no_answer') return 'dial_no_answer';
  if (reason === 'user_hangup' && dur < 180) return 'early_user_hangup';
  if (reason === 'user_hangup') return 'long_user_hangup';
  if (reason === 'agent_hangup') return 'agent_hangup';
  if (reason === 'max_duration_reached') return 'max_duration';
  return 'other';
}

const byNumber = new Map();
for (const c of allCalls) {
  const num = c.from_number || 'unknown';
  if (!byNumber.has(num)) {
    byNumber.set(num, {
      total: 0, dial_no_answer: 0, early_user_hangup: 0, long_user_hangup: 0,
      agent_hangup: 0, max_duration: 0, other: 0,
      total_duration_s: 0,
    });
  }
  const bucket = byNumber.get(num);
  bucket.total++;
  bucket[classify(c)]++;
  bucket.total_duration_s += (c.duration_ms || 0) / 1000;
}

// 4) Report — sorted by no_answer + early_hangup rate (worst first)
const rows = [...byNumber.entries()].map(([num, b]) => {
  const noAnswer = b.dial_no_answer;
  const earlyHangup = b.early_user_hangup;
  const success = b.long_user_hangup + b.agent_hangup + b.max_duration;
  const failRate = b.total > 0 ? (noAnswer + earlyHangup) / b.total : 0;
  return { num, b, noAnswer, earlyHangup, success, failRate };
});
rows.sort((a, b) => b.failRate - a.failRate);

console.log(`\nFrom-number health, last ${DAYS_BACK} days:`);
console.log('═'.repeat(110));
console.log(['Number'.padEnd(16), 'Total', 'NoAns', 'EarlyHup', 'LongHup', 'AgentEnd', 'MaxDur', 'Other', 'FailRate', 'Flag'].join('\t'));
console.log('─'.repeat(110));
for (const r of rows) {
  const b = r.b;
  const flag = r.failRate > 0.60 ? '⚠ RETIRE'
             : r.failRate > 0.35 ? '◐ WATCH'
             : '✓ healthy';
  console.log([
    (r.num || 'unknown').padEnd(16),
    String(b.total).padStart(5),
    String(b.dial_no_answer).padStart(5),
    String(b.early_user_hangup).padStart(8),
    String(b.long_user_hangup).padStart(7),
    String(b.agent_hangup).padStart(8),
    String(b.max_duration).padStart(6),
    String(b.other).padStart(5),
    (r.failRate * 100).toFixed(0) + '%',
    flag,
  ].join('\t'));
}
console.log('═'.repeat(110));

console.log(`\nFlagging logic:
  ⚠ RETIRE if (dial_no_answer + early_user_hangup) / total > 60%
  ◐ WATCH  if 35% < ratio ≤ 60%
  ✓ healthy if ≤ 35%

  early_user_hangup = IRS picked up but hung up within 180s (IVR rejection or auto-disconnect before live agent)
  long_user_hangup  = the IRS itself ended the call after >180s (often after IVR menu / verification — typically a normal end)
  agent_hangup      = our AI ended the call (e.g. PHASE 2B bailout when wait too long)
  max_duration      = call ran the full Retell limit (3600s) — normally means agent answered and we did real work`);
