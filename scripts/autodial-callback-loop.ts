/**
 * Autodial loop tuned for callback-only outcomes:
 *
 *   1. Fire autodial with CALLBACK_PHONE=6507411085 (iCloud expert cell)
 *   2. Poll the irs_call_sessions row every 15s for either:
 *        - callback_status='accepted'  → SUCCESS, stop the loop
 *        - 3 minutes elapsed without any callback offer signal → BAIL,
 *          kill the in-flight Retell call, restart the loop
 *   3. Up to MAX_ATTEMPTS in case IRS just isn't offering callbacks today
 *
 * Driver: MOD-226 — the Retell agent gives up at ~152s on long IRS
 * disclaimers. Matt's directive: "if no callback offer in 3 min, start
 * again." Don't burn 12 min per attempt holding for an outcome that
 * isn't coming.
 *
 * Per-call billable cost ≈ $0.04 (Retell 3-min ceiling), vs ~$0.25 at
 * the 12-min default. Gives us ~6× more attempts in the same dollar
 * budget while we wait for the IRS callback queue to thaw.
 */

import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const CALLBACK_PHONE_OVERRIDE = '6507411085'; // iCloud expert cell, per Matt 2026-05-14
const PER_CALL_TIMEOUT_MS = 3 * 60 * 1000;
const POLL_INTERVAL_MS = 15_000;
const MAX_ATTEMPTS = 8;
const COOLDOWN_BETWEEN_ATTEMPTS_MS = 30_000;

function spawnAutodial(): Promise<{ child: ReturnType<typeof spawn>; sessionIdPromise: Promise<string | null> }> {
  const childEnv = { ...process.env, AUTODIAL_CALLBACK_PHONE: CALLBACK_PHONE_OVERRIDE };
  const child = spawn('npx', ['-y', 'tsx', 'scripts/autodial-irs-callback.ts'], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Watch stdout for the session id line
  let sessionId: string | null = null;
  let sessionResolve: (v: string | null) => void;
  const sessionIdPromise = new Promise<string | null>(r => { sessionResolve = r; });
  child.stdout?.on('data', (chunk) => {
    const s = chunk.toString();
    process.stdout.write(s);
    const m = s.match(/Session id:\s+([a-f0-9-]{36})/);
    if (m && !sessionId) {
      sessionId = m[1];
      sessionResolve(sessionId);
    }
  });
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk.toString()));

  // Resolve null after 30s if no session id ever surfaces
  setTimeout(() => { if (!sessionId) sessionResolve(null); }, 30_000);

  return { child, sessionIdPromise };
}

async function pollSession(sessionId: string, deadlineMs: number): Promise<{
  outcome: 'callback_accepted' | 'rejected' | 'timeout';
  hold_seconds: number;
  callback_phone?: string;
}> {
  while (Date.now() < deadlineMs) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const { data: row } = await sb
      .from('irs_call_sessions')
      .select('classified_outcome, callback_status, hold_seconds, callback_phone, error_message, retry_reason')
      .eq('id', sessionId)
      .single() as { data: any };
    if (!row) continue;

    if (row.callback_status === 'accepted' || row.classified_outcome === 'callback_accepted') {
      return { outcome: 'callback_accepted', hold_seconds: row.hold_seconds || 0, callback_phone: row.callback_phone };
    }
    if (['overflow_rejected', 'wait_too_long_no_callback', 'agent_disconnected'].includes(row.classified_outcome)) {
      return { outcome: 'rejected', hold_seconds: row.hold_seconds || 0 };
    }
    // still in progress — keep polling
    process.stdout.write(`  [poll] callback_status=${row.callback_status || 'pending'} outcome=${row.classified_outcome || 'pending'} hold=${row.hold_seconds || 0}s\n`);
  }
  return { outcome: 'timeout', hold_seconds: Math.floor((PER_CALL_TIMEOUT_MS) / 1000) };
}

async function killProcessTree(child: ReturnType<typeof spawn>) {
  try { child.kill('SIGKILL'); } catch {}
  // Also reap any orphan tsx/npx children
  await new Promise<void>(r => setTimeout(r, 500));
  spawn('pkill', ['-9', '-f', 'autodial-irs-callback'], { stdio: 'ignore' });
}

console.log(`\n${'═'.repeat(80)}`);
console.log(`Autodial CALLBACK loop — iCloud expert (matthewaparker@icloud.com)`);
console.log(`Callback phone (override): ${CALLBACK_PHONE_OVERRIDE} (650-741-1085)`);
console.log(`Per-call timeout:           3 min`);
console.log(`Cooldown between attempts:  30 sec`);
console.log(`Max attempts:               ${MAX_ATTEMPTS}`);
console.log(`${'═'.repeat(80)}\n`);

async function main() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n──── Attempt ${attempt}/${MAX_ATTEMPTS} ────`);
    const { child, sessionIdPromise } = spawnAutodial();
    const sessionId = await sessionIdPromise;
    if (!sessionId) {
      console.log('  ✗ Could not extract session id within 30s — skipping');
      await killProcessTree(child);
      continue;
    }
    console.log(`  Session: ${sessionId} — polling for callback offer (3-min budget)…`);

    const result = await pollSession(sessionId, Date.now() + PER_CALL_TIMEOUT_MS);
    await killProcessTree(child);

    if (result.outcome === 'callback_accepted') {
      console.log(`\n${'═'.repeat(80)}`);
      console.log(`✅ CALLBACK ACCEPTED — IRS will text/call ${result.callback_phone || CALLBACK_PHONE_OVERRIDE}`);
      console.log(`Hold seconds before callback: ${result.hold_seconds}`);
      console.log(`${'═'.repeat(80)}\n`);
      process.exit(0);
    } else if (result.outcome === 'rejected') {
      console.log(`  ✗ Rejected (hold=${result.hold_seconds}s) — restart in ${COOLDOWN_BETWEEN_ATTEMPTS_MS / 1000}s`);
    } else {
      console.log(`  ⏱ No callback offered within 3 min — bail + restart in ${COOLDOWN_BETWEEN_ATTEMPTS_MS / 1000}s`);
    }
    if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, COOLDOWN_BETWEEN_ATTEMPTS_MS));
  }

  console.log(`\n${MAX_ATTEMPTS} attempts exhausted without a callback offer. IRS callback queue may be closed for the day.`);
  process.exit(1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
