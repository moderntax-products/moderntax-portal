#!/usr/bin/env node
/**
 * Autodial IRS PPS for the iCloud expert until a callback ETA is locked in.
 *
 * Flow per attempt:
 *   1. Create irs_call_sessions row scheduled_for now + irs_call_entities
 *   2. Fire via lib/fire-call.fireScheduledCall — Retell PPS agent dials IRS
 *   3. Poll the session for ~12 min, watching for callback_status='accepted'
 *      OR a terminal failure
 *   4. Report outcome:
 *        - callback_accepted     → success, stop
 *        - wait_too_long_no_callback → retry from a different from-number
 *        - overflow_rejected     → retry later (line full, not our fault)
 *        - timeout (~12 min)     → mark stale, retry
 *
 * Defaults to callback_phone=7042775862 (Matt's cell per matt's 2026-05-13
 * directive). Falls back to expert profile's phone_number if env override
 * is set.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

// Load env BEFORE any module that reads it
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

import { fireScheduledCall } from '../lib/fire-call';
import { extractPpsSignals } from '../lib/irs-pps-signal-extractor';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

// Matt's iCloud expert
const EXPERT_ID = 'bd374d60-5146-4ca9-90e6-29af28af641f';
const CAF_NUMBER = '0316-30210R';
const EXPERT_NAME = 'Matthew Parker, C/O ModernTax, Inc.';
const EXPERT_FAX = '415-900-4436';
const SOR_ID = 'MPARKER31';
// Matt asked for callback to this number (per 2026-05-13 directive).
// Falls back to profile.phone_number if not set in env.
const CALLBACK_PHONE = process.env.AUTODIAL_CALLBACK_PHONE || '7042775862';

// Entities are discovered dynamically: any irs_queue entity assigned to
// the iCloud expert with a signed 8821 on file. The Retell agent caps
// at 5 entities per call (per buildIrsPpsPrompt). Hardcoded list kept
// as a fallback for testing/recovery.
const FALLBACK_ENTITY_IDS = [
  'f92264b1-d420-4865-93f0-33943fc507ff',  // Mento Technologies, Inc.
  '743a3929-71c3-433b-be88-af6e27998f2e',  // 922 KILBURN OPERATIONS LLC (MaxMart)
];

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

async function main() {
  const attemptId = Date.now().toString(36);
  console.log(`\n=== AUTODIAL ATTEMPT ${attemptId} · ${new Date().toISOString()} ===`);
  console.log(`Expert: ${EXPERT_NAME}`);
  console.log(`CAF: ${CAF_NUMBER} · Fax: ${EXPERT_FAX} · SOR: ${SOR_ID}`);
  console.log(`Callback phone: ${CALLBACK_PHONE} (${formatPhone(CALLBACK_PHONE)})`);

  // 1. DISCOVER open assignments: any 'assigned' or 'in_progress' for the
  // iCloud expert on an entity that's currently in irs_queue with a signed
  // 8821 on file. Cap at 5 (Retell agent's per-call entity max).
  const { data: assignments } = await sb
    .from('expert_assignments')
    .select('id, entity_id, status, request_entities!inner(entity_name, status, signed_8821_url)')
    .eq('expert_id', EXPERT_ID)
    .in('status', ['assigned', 'in_progress'])
    .eq('request_entities.status', 'irs_queue')
    .not('request_entities.signed_8821_url', 'is', null)
    .order('assigned_at', { ascending: true })
    .limit(5) as { data: any[] | null };

  if (!assignments || assignments.length === 0) {
    console.log('No open assignments matching {irs_queue + signed 8821 + expert} criteria.');
    console.log('All clear — nothing to dial.');
    process.exit(2);  // exit code 2 = nothing to do (loop should stop)
  }
  console.log(`Found ${assignments.length} open assignment(s) to call about:`);
  for (const a of assignments) {
    console.log(`  · ${a.request_entities?.entity_name} (assn=${a.status}, ent=${a.request_entities?.status})`);
  }
  const ENTITY_IDS = assignments.map(a => a.entity_id);

  // 2. Create the call session
  const { data: session, error: sErr } = await sb
    .from('irs_call_sessions' as any)
    .insert({
      expert_id: EXPERT_ID,
      status: 'scheduled',
      caf_number: CAF_NUMBER,
      expert_name: EXPERT_NAME,
      expert_fax: EXPERT_FAX,
      expert_sor_id: SOR_ID,
      scheduled_for: new Date().toISOString(),
      scheduled_timezone: 'America/Los_Angeles',
      callback_phone: CALLBACK_PHONE,
      callback_mode: 'irs_callback',
      callback_status: 'waiting',
    })
    .select()
    .single() as { data: any; error: any };
  if (sErr || !session) {
    console.error('Failed to create call session:', sErr);
    process.exit(1);
  }
  console.log(`Session id: ${session.id}`);

  // 3. Attach entities
  const { data: entityRows } = await sb.from('request_entities')
    .select('id, entity_name, tid, tid_kind, form_type, years')
    .in('id', ENTITY_IDS) as { data: any[] | null };
  const callEntities = assignments.map(a => {
    const e = entityRows!.find(r => r.id === a.entity_id);
    return {
      call_session_id: session.id,
      assignment_id: a.id,
      entity_id: a.entity_id,
      taxpayer_tid: e?.tid,
      taxpayer_name: e?.entity_name,
      form_type: e?.form_type,
      tax_years: e?.years,
    };
  });
  const { error: eErr } = await sb.from('irs_call_entities' as any).insert(callEntities);
  if (eErr) { console.error('Failed to create call entities:', eErr); process.exit(1); }
  console.log(`Attached ${callEntities.length} entities`);
  for (const ce of callEntities) {
    console.log(`  · ${ce.taxpayer_name} (${ce.taxpayer_tid}) form=${ce.form_type}`);
  }

  // 4. Fire via Retell
  console.log(`\nFiring Retell call…`);
  let fireResult;
  try {
    fireResult = await fireScheduledCall(sb, session.id);
    console.log(`✓ Call placed: ${fireResult.provider} ${fireResult.call_id}`);
    console.log(`  from_number: ${fireResult.from_number || '?'}`);
  } catch (err: any) {
    console.error(`✗ Call placement failed:`, err.message);
    process.exit(1);
  }

  // 5. Poll for callback acceptance / completion
  console.log(`\nPolling session ${session.id} for outcome…`);
  const POLL_INTERVAL_MS = 20_000;  // every 20s
  const POLL_TIMEOUT_MS = 12 * 60_000;  // 12 minutes
  const startTime = Date.now();
  let finalStatus = '';
  let callbackEta = null as string | null;

  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const { data: s } = await sb.from('irs_call_sessions' as any)
      .select('status, callback_status, callback_initiated_at, callback_connected_at, ended_at, error_message, retry_reason, classified_outcome')
      .eq('id', session.id).single() as { data: any };
    if (!s) {
      console.log(`  [poll] session row vanished — aborting poll`);
      finalStatus = 'session_lost';
      break;
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`  [${elapsed}s] status=${s.status} · callback_status=${s.callback_status} · ended=${s.ended_at?.slice(11,16) || '-'}`);

    if (s.callback_status === 'accepted') {
      finalStatus = 'callback_accepted';
      callbackEta = s.callback_initiated_at || s.callback_connected_at || null;
      console.log(`\n✓ CALLBACK ACCEPTED!`);
      console.log(`  Accepted at: ${callbackEta}`);
      console.log(`  → IRS will call back ${CALLBACK_PHONE} (${formatPhone(CALLBACK_PHONE)})`);
      break;
    }
    if (s.status === 'completed' || s.status === 'failed' || s.ended_at) {
      finalStatus = s.classified_outcome || s.retry_reason || s.error_message || s.status;
      console.log(`\n✗ Call ended without callback. Reason: ${finalStatus}`);
      break;
    }
  }

  if (!finalStatus) {
    finalStatus = 'timeout';
    console.log(`\n⏱ Timeout after ${POLL_TIMEOUT_MS / 60000} min — call still in progress or stuck.`);
  }

  // -------------------------------------------------------------------
  // POST-CALL ANALYTICS — every IRS PPS call is a real-time poll of
  // IRS queue health. Extract structured signals from the transcript
  // (wait time announced, callback offered, agent reached, badge etc.)
  // and persist to the session row so the admin stats page can show
  // observed wait-time trends and inform customer SLA estimates.
  // -------------------------------------------------------------------
  console.log(`\nExtracting IRS PPS signals from call transcript…`);
  try {
    const r = await fetch(`https://api.retellai.com/v2/get-call/${fireResult.call_id}`, {
      headers: { 'Authorization': `Bearer ${process.env.RETELL_API_KEY}` },
    });
    if (r.ok) {
      const call = await r.json();
      const signals = extractPpsSignals(call.transcript || '', call.duration_ms || 0, call.disconnection_reason || null);
      const tags = [
        signals.announcedWaitMinutes !== null ? `wait_${signals.announcedWaitMinutes}min` : null,
        signals.callbackOffered ? 'callback_offered' : 'no_callback_offered',
        signals.overflowRejected ? 'overflow_rejected' : null,
        signals.agentAnswered ? 'agent_answered' : null,
      ].filter(Boolean) as string[];
      const classifiedOutcome = signals.agentAnswered ? 'agent_answered'
        : signals.callbackOffered ? 'callback_offered_but_not_taken'
        : signals.overflowRejected ? 'overflow_rejected'
        : signals.announcedWaitMinutes && signals.announcedWaitMinutes > 15 ? 'wait_too_long_no_callback'
        : 'short_call_no_signal';
      await sb.from('irs_call_sessions' as any)
        .update({
          call_summary: signals.summary,
          irs_agent_name: signals.agentName,
          irs_agent_badge: signals.agentBadge,
          hold_duration_seconds: signals.holdSeconds,
          coaching_tags: tags,
          classified_outcome: classifiedOutcome,
        })
        .eq('id', session.id);
      console.log(`✓ Signals persisted:`);
      console.log(`    announced_wait: ${signals.announcedWaitMinutes !== null ? signals.announcedWaitMinutes + ' min' : 'not announced'}`);
      console.log(`    callback_offered: ${signals.callbackOffered}`);
      console.log(`    overflow_rejected: ${signals.overflowRejected}`);
      console.log(`    agent_answered: ${signals.agentAnswered}`);
      console.log(`    agent_name: ${signals.agentName || '—'}`);
      console.log(`    agent_badge: ${signals.agentBadge || '—'}`);
      console.log(`    hold_seconds: ${signals.holdSeconds || '—'}`);
      console.log(`    classified_outcome: ${classifiedOutcome}`);
      console.log(`    tags: ${tags.join(', ')}`);
    }
  } catch (extractErr: any) {
    console.warn(`signal extraction failed (non-blocking): ${extractErr.message}`);
  }

  console.log(`\n=== ATTEMPT ${attemptId} COMPLETE ===`);
  console.log(`Outcome: ${finalStatus}`);
  if (callbackEta) console.log(`Callback ETA: ${callbackEta} min`);
  process.exit(finalStatus === 'callback_accepted' ? 0 : 1);
}

function formatPhone(p: string): string {
  const digits = p.replace(/\D/g, '');
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return p;
}
