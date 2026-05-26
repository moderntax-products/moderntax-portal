/**
 * Multi-expert IRS PPS callback bot — 45-minute budget, concurrent per expert.
 *
 * Fires callback-mode PPS calls for two experts in parallel until each
 * gets a confirmed callback accepted by the IRS rep OR the total 45-min
 * budget is exhausted.
 *
 * Provider selection: Bland AI first if positive balance, else Retell.
 * Bland costs ~$0.75/call vs Retell ~$2.08/call per the 2026-05-23 audit;
 * use Bland when affordable.
 *
 * Per-expert loop:
 *   - Spawn one call at a time (no double-dialing IRS for the same expert)
 *   - 3-min poll budget per call (matches scripts/autodial-callback-loop.ts)
 *   - On callback_status='accepted', stop that expert's loop
 *   - 30s cooldown between attempts
 *
 * Driver: 2026-05-26 — Matt's iCloud expert hit 2 busy signals on manual
 * PPS dials; Joel has 3 entities (j&j mechanical, Blue Ocean, Agoura
 * Hills Alliance) sitting in irs_queue with no expert call attempts yet.
 * The IRS line state changes hour-by-hour and per-line; better to have
 * automated callback retries running in the background than burn an
 * expert's time on manual redials.
 *
 * Run:
 *   npx -y dotenv-cli -e .env.local -- npx tsx scripts/multi-expert-callback-bot.ts
 */

import { createClient } from '@supabase/supabase-js';

const TOTAL_BUDGET_MS = 45 * 60 * 1000;
const PER_CALL_POLL_INTERVAL_MS = 20_000;
const PER_CALL_BUDGET_MS = 3 * 60 * 1000;
const COOLDOWN_BETWEEN_ATTEMPTS_MS = 30_000;

interface ExpertConfig {
  id: string;
  label: string;
  callbackPhone: string;
}

// IDs verified via pre-flight 2026-05-26
const EXPERTS: ExpertConfig[] = [
  { id: 'bd374d60-5146-4ca9-90e6-29af28af641f', label: 'iCloud Matt',     callbackPhone: '6507411085' },
  { id: '8487c808-07a3-45c9-a968-0ffdbbd83ec7', label: 'Joel Abernathy',  callbackPhone: '3362535069' },
];

async function main() {
  const startTime = Date.now();
  const deadline = startTime + TOTAL_BUDGET_MS;

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`Multi-expert PPS callback bot — 45-min total budget`);
  console.log(`Started: ${new Date(startTime).toISOString()}`);
  console.log(`Deadline: ${new Date(deadline).toISOString()}`);
  console.log(`${'═'.repeat(80)}\n`);

  // Provider selection — check Bland balance once at start
  let provider: 'bland' | 'retell' = 'retell';
  try {
    const r = await fetch('https://api.bland.ai/v1/me', { headers: { Authorization: process.env.BLAND_API_KEY! } });
    if (r.ok) {
      const me = await r.json();
      const bal = me.billing?.current_balance ?? 0;
      console.log(`Bland balance: $${bal.toFixed(2)}`);
      if (bal > 1) {
        provider = 'bland';
        console.log(`✓ Using BLAND ($0.75/call avg, cheaper)`);
      } else {
        console.log(`! Bland balance too low — falling back to RETELL ($2.08/call avg)`);
      }
    }
  } catch { console.warn('Bland balance check failed; using Retell'); }
  console.log();

  // Pre-flight per-expert: confirm queue has callable entities
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const expertsWithWork: ExpertConfig[] = [];
  for (const e of EXPERTS) {
    const { data: assns } = await sb.from('expert_assignments')
      .select('id, request_entities!inner(entity_name, status, signed_8821_url)')
      .eq('expert_id', e.id)
      .in('status', ['assigned', 'in_progress'])
      .eq('request_entities.status', 'irs_queue')
      .not('request_entities.signed_8821_url', 'is', null)
      .limit(5) as any;
    const n = assns?.length || 0;
    console.log(`${e.label}: ${n} callable entit${n === 1 ? 'y' : 'ies'}`);
    if (n > 0) expertsWithWork.push(e);
  }
  if (expertsWithWork.length === 0) { console.log('No expert has callable work. Exiting.'); return; }
  console.log();

  // Concurrent per-expert loops
  const results = await Promise.all(expertsWithWork.map((e) => runExpertLoop(e, provider, deadline)));

  console.log(`\n${'═'.repeat(80)}\nFINAL RESULTS\n${'═'.repeat(80)}`);
  for (const r of results) {
    const status = r.callbackAccepted ? '✅ CALLBACK ACCEPTED' : `✗ ${r.attempts} attempts, no callback`;
    console.log(`  ${r.expert.label.padEnd(20)} ${status}`);
    if (r.lastSessionId) console.log(`    last session: ${r.lastSessionId}`);
    if (r.callbackEtaMin) console.log(`    callback ETA: ~${r.callbackEtaMin} min`);
  }
  const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\nTotal wall time: ${elapsedMin} min`);
}

interface LoopResult {
  expert: ExpertConfig;
  attempts: number;
  callbackAccepted: boolean;
  lastSessionId: string | null;
  callbackEtaMin: number | null;
}

async function runExpertLoop(
  expert: ExpertConfig,
  provider: 'bland' | 'retell',
  deadline: number,
): Promise<LoopResult> {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const result: LoopResult = { expert, attempts: 0, callbackAccepted: false, lastSessionId: null, callbackEtaMin: null };

  while (Date.now() < deadline) {
    result.attempts++;
    const attemptStart = Date.now();
    console.log(`\n[${expert.label}] ──── Attempt ${result.attempts} @ ${new Date().toISOString().slice(11, 19)} ────`);

    let sessionId: string | null = null;
    try {
      sessionId = await fireOneCall(expert, provider);
      result.lastSessionId = sessionId;
      console.log(`[${expert.label}] Session ${sessionId} fired via ${provider}`);
    } catch (err: any) {
      console.error(`[${expert.label}] Fire failed: ${err.message}`);
      // If Bland 402, switch to Retell for rest of loop
      if (provider === 'bland' && /402|insufficient|balance/i.test(err.message)) {
        console.warn(`[${expert.label}] Bland out of balance — switching to Retell`);
        provider = 'retell';
      }
      await sleep(COOLDOWN_BETWEEN_ATTEMPTS_MS);
      continue;
    }

    // Poll the session for outcome
    const pollDeadline = Math.min(attemptStart + PER_CALL_BUDGET_MS, deadline);
    while (Date.now() < pollDeadline) {
      await sleep(PER_CALL_POLL_INTERVAL_MS);
      const { data: s } = await sb.from('irs_call_sessions')
        .select('callback_status, callback_initiated_at, classified_outcome, status, ended_at')
        .eq('id', sessionId).single() as any;
      if (!s) continue;
      const elapsed = ((Date.now() - attemptStart) / 1000).toFixed(0);
      console.log(`[${expert.label}] [${elapsed}s] status=${s.status} cb=${s.callback_status} outcome=${s.classified_outcome || '-'}`);

      if (s.callback_status === 'accepted' || s.classified_outcome === 'callback_accepted') {
        result.callbackAccepted = true;
        // Try to parse ETA from callback_initiated_at vs now
        if (s.callback_initiated_at) {
          const etaMs = new Date(s.callback_initiated_at).getTime() - Date.now();
          if (etaMs > 0) result.callbackEtaMin = Math.round(etaMs / 60000);
        }
        console.log(`[${expert.label}] ✅ CALLBACK ACCEPTED on attempt ${result.attempts}`);
        return result;
      }
      if (['overflow_rejected', 'agent_disconnected', 'wait_too_long_no_callback'].includes(s.classified_outcome)) {
        console.log(`[${expert.label}] outcome=${s.classified_outcome} — bailing this attempt`);
        break;
      }
      if (s.status === 'completed' || s.status === 'failed' || s.ended_at) {
        console.log(`[${expert.label}] call ended (status=${s.status}) — bailing`);
        break;
      }
    }

    console.log(`[${expert.label}] Attempt ${result.attempts} finished without callback. Cooling down ${COOLDOWN_BETWEEN_ATTEMPTS_MS / 1000}s.`);
    await sleep(COOLDOWN_BETWEEN_ATTEMPTS_MS);
  }
  console.log(`[${expert.label}] 45-min deadline hit after ${result.attempts} attempts. Stopping.`);
  return result;
}

/**
 * Create + fire one IRS PPS callback call for an expert. Returns the
 * session_id. Throws on fire failure.
 *
 * Uses the same DB-row-then-fire-via-lib pattern as
 * scripts/autodial-irs-callback.ts but condensed for the multi-expert
 * bot. Picks up the expert's open assignments dynamically (caps at 5
 * per call per the Retell agent's per-call entity max).
 */
async function fireOneCall(expert: ExpertConfig, provider: 'bland' | 'retell'): Promise<string> {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data: profile } = await sb.from('profiles')
    .select('full_name, caf_number, expert_address, fax_number, sor_id, address')
    .eq('id', expert.id).single() as any;

  const { data: assignments } = await sb.from('expert_assignments')
    .select('id, entity_id, request_entities!inner(entity_name, status, signed_8821_url)')
    .eq('expert_id', expert.id)
    .in('status', ['assigned', 'in_progress'])
    .eq('request_entities.status', 'irs_queue')
    .not('request_entities.signed_8821_url', 'is', null)
    .order('assigned_at', { ascending: true })
    .limit(5) as any;
  if (!assignments?.length) throw new Error('No callable assignments');
  const entityIds = assignments.map((a: any) => a.entity_id);

  // Create session row
  const { data: session, error: sErr } = await sb.from('irs_call_sessions')
    .insert({
      expert_id: expert.id,
      status: 'scheduled',
      caf_number: profile?.caf_number || '',
      expert_name: profile?.full_name || expert.label,
      expert_fax: profile?.fax_number || '',
      expert_sor_id: profile?.sor_id || '',
      scheduled_for: new Date().toISOString(),
      scheduled_timezone: 'America/Los_Angeles',
      callback_phone: expert.callbackPhone,
      callback_mode: 'irs_callback',
      callback_status: 'waiting',
    } as any)
    .select('id').single() as any;
  if (sErr || !session) throw new Error(`session create failed: ${sErr?.message}`);

  // Attach entities
  const { data: entityRows } = await sb.from('request_entities')
    .select('id, entity_name, tid, tid_kind, form_type, years')
    .in('id', entityIds) as any;
  await sb.from('irs_call_entities').insert(assignments.map((a: any) => {
    const e = entityRows!.find((r: any) => r.id === a.entity_id);
    return {
      call_session_id: session.id,
      assignment_id: a.id,
      entity_id: a.entity_id,
      taxpayer_tid: e?.tid,
      taxpayer_name: e?.entity_name,
      form_type: e?.form_type,
      tax_years: e?.years,
    };
  }) as any);

  // Fire via the appropriate provider — set CALL_PROVIDER env at the
  // module level so fireScheduledCall picks the right path.
  process.env.CALL_PROVIDER = provider;
  // Dynamic import so the provider env is honored at import time
  const { fireScheduledCall } = await import('../lib/fire-call');
  const result = await fireScheduledCall(sb as any, session.id);
  console.log(`  ↳ ${provider} call_id=${result.call_id} from=${result.from_number || '?'}`);
  return session.id;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
