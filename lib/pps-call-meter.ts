/**
 * PPS Call Meter — cost model + event derivation for the Metered AI Call pilot
 * (Build Spec v0.1). Deterministic cost math kept out of any UI/route so the
 * pilot dashboard and the operator console agree to the penny.
 *
 * The whole pilot exists to validate one number: human_attached time per
 * entity, against the 51.3 min/entity baseline coded from the 2026-07-10 call.
 */

import { PAYROLL_DEFAULTS } from './expert-payroll';

export const PPS_METER = {
  /** Expert cost — the same $45/hr the payout engine uses. */
  EXPERT_HOURLY_RATE: PAYROLL_DEFAULTS.HOURLY_RATE,
  /** Voice-AI per-minute rates (Phase 1+ only; Phase 0 has no AI voice). */
  AI_RATE_PER_MIN: { bland: 0.09, retell: 0.07 } as Record<string, number>,
  /** Per-transmission fax cost incl. one retry bucket. Refine w/ Sinch invoicing. */
  FAX_COST_USD: 0.02,
  /** Baselines from the 2026-07-10 call analysis (spec v0.1). */
  BASELINE_MIN_PER_ENTITY: 51.3,
  BASELINE_COST_PER_ENTITY: 41.49,
  /** Kill criterion: if human-attached min/entity can't get below this, stop. */
  KILL_MIN_PER_ENTITY: 30,
  /** Phase-0 success target. */
  TARGET_MIN_PER_ENTITY: 20,
} as const;

export type PpsClient = 'centerstone' | 'cal_statewide';
export type PpsOutcome = 'completed' | 'irs_rejected' | 'disconnected' | 'escalated' | 'agent_refused';
export type PpsPhase = 'manual' | 'phase0' | 'phase1' | 'phase2';

export interface PpsMeterInput {
  client: PpsClient;
  request_id?: string | null;
  entity_ids?: string[];
  entities_on_call: number;
  phase?: PpsPhase;

  // time decomposition (seconds)
  dial_to_ivr_sec?: number;
  ivr_nav_sec?: number;
  queue_wait_sec?: number;      // pre-agent, fully automatable
  total_hold_sec?: number;      // mid-call holds, fully automatable
  active_talk_sec?: number;
  human_attached_sec: number;   // THE MONEY METRIC
  total_call_sec: number;

  // cost inputs
  ai_minutes?: number;
  ai_provider?: 'bland' | 'retell';

  // fax reliability
  fax_sent_at?: string | null;
  fax_confirmed_at?: string | null;
  fax_retries?: number;

  // outcome
  outcome: PpsOutcome;
  rejection_reason?: string | null;
  transcripts_ordered?: unknown;
  escalation_trigger?: string | null;
  notes?: string | null;
}

export interface PpsMeterDerived {
  ai_cost_usd: number;
  human_cost_usd: number;
  fax_cost_usd: number;
  total_cost_usd: number;
  /** The metric that decides everything. */
  human_attached_min_per_entity: number;
  cost_per_entity_usd: number;
  /** Δ vs baseline — negative = improvement. */
  vs_baseline_min: number;
  vs_baseline_cost: number;
  /** queue_wait + total_hold — the fully-automatable Phase-0 lever. */
  automatable_wait_sec: number;
  automatable_wait_pct: number; // share of total call that is pure waiting
  /** Verdict flags against the spec's success / kill lines. */
  meets_phase0_target: boolean;
  below_kill_line: boolean;
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export function derivePpsCosts(input: PpsMeterInput): PpsMeterDerived {
  const aiMin = Number(input.ai_minutes) || 0;
  const aiRate = PPS_METER.AI_RATE_PER_MIN[input.ai_provider || 'bland'] ?? PPS_METER.AI_RATE_PER_MIN.bland;
  const ai_cost_usd = round2(aiMin * aiRate);

  const humanSec = Math.max(0, Number(input.human_attached_sec) || 0);
  const human_cost_usd = round2((humanSec / 3600) * PPS_METER.EXPERT_HOURLY_RATE);

  const faxRetries = Math.max(0, Number(input.fax_retries) || 0);
  const fax_cost_usd = round2((1 + faxRetries) * PPS_METER.FAX_COST_USD);

  const total_cost_usd = round2(ai_cost_usd + human_cost_usd + fax_cost_usd);

  const n = Math.max(1, Number(input.entities_on_call) || 1);
  const human_attached_min_per_entity = round2(humanSec / n / 60);
  const cost_per_entity_usd = round2(total_cost_usd / n);

  const automatable_wait_sec = (Number(input.queue_wait_sec) || 0) + (Number(input.total_hold_sec) || 0);
  const totalSec = Math.max(1, Number(input.total_call_sec) || 1);

  return {
    ai_cost_usd,
    human_cost_usd,
    fax_cost_usd,
    total_cost_usd,
    human_attached_min_per_entity,
    cost_per_entity_usd,
    vs_baseline_min: round2(human_attached_min_per_entity - PPS_METER.BASELINE_MIN_PER_ENTITY),
    vs_baseline_cost: round2(cost_per_entity_usd - PPS_METER.BASELINE_COST_PER_ENTITY),
    automatable_wait_sec,
    automatable_wait_pct: round2((automatable_wait_sec / totalSec) * 100),
    meets_phase0_target: human_attached_min_per_entity < PPS_METER.TARGET_MIN_PER_ENTITY,
    below_kill_line: human_attached_min_per_entity < PPS_METER.KILL_MIN_PER_ENTITY,
  };
}

/** Build the DB row (spec columns + derived costs) ready for insert. */
export function buildMeterRow(input: PpsMeterInput, operatorId?: string | null) {
  const d = derivePpsCosts(input);
  return {
    started_at: new Date().toISOString(),
    client: input.client,
    request_id: input.request_id || null,
    entity_ids: input.entity_ids && input.entity_ids.length ? input.entity_ids : null,
    entities_on_call: Math.max(1, Number(input.entities_on_call) || 1),
    dial_to_ivr_sec: input.dial_to_ivr_sec ?? null,
    ivr_nav_sec: input.ivr_nav_sec ?? null,
    queue_wait_sec: input.queue_wait_sec ?? null,
    total_hold_sec: input.total_hold_sec ?? null,
    active_talk_sec: input.active_talk_sec ?? null,
    human_attached_sec: Math.max(0, Number(input.human_attached_sec) || 0),
    total_call_sec: Math.max(0, Number(input.total_call_sec) || 0),
    ai_minutes: input.ai_minutes ?? null,
    ai_cost_usd: d.ai_cost_usd,
    human_cost_usd: d.human_cost_usd,
    fax_cost_usd: d.fax_cost_usd,
    total_cost_usd: d.total_cost_usd,
    fax_sent_at: input.fax_sent_at || null,
    fax_confirmed_at: input.fax_confirmed_at || null,
    fax_retries: input.fax_retries ?? 0,
    outcome: input.outcome,
    rejection_reason: input.rejection_reason || null,
    transcripts_ordered: input.transcripts_ordered ?? null,
    escalation_trigger: input.escalation_trigger || null,
    notes: input.notes || null,
    phase: input.phase || 'manual',
    operator_id: operatorId || null,
  };
}

/** Roll a set of metered calls into the numbers the pilot dashboard tracks. */
export function summarizeMeters(rows: Array<Record<string, any>>) {
  if (!rows.length) {
    return { calls: 0, entities: 0, avg_human_min_per_entity: 0, avg_cost_per_entity: 0,
      completion_rate: 0, rejection_rate: 0, avg_automatable_wait_pct: 0,
      fax_first_attempt_success_rate: 0 };
  }
  const entities = rows.reduce((s, r) => s + (Number(r.entities_on_call) || 0), 0) || 1;
  const totalHumanSec = rows.reduce((s, r) => s + (Number(r.human_attached_sec) || 0), 0);
  const totalCost = rows.reduce((s, r) => s + (Number(r.total_cost_usd) || 0), 0);
  const completed = rows.filter((r) => r.outcome === 'completed').length;
  const rejected = rows.filter((r) => r.outcome === 'irs_rejected').length;
  const faxRows = rows.filter((r) => r.fax_sent_at);
  const faxFirstOk = faxRows.filter((r) => r.fax_confirmed_at && (Number(r.fax_retries) || 0) === 0).length;
  const waitPcts = rows.map((r) => {
    const wait = (Number(r.queue_wait_sec) || 0) + (Number(r.total_hold_sec) || 0);
    const total = Math.max(1, Number(r.total_call_sec) || 1);
    return (wait / total) * 100;
  });
  return {
    calls: rows.length,
    entities,
    avg_human_min_per_entity: round2(totalHumanSec / entities / 60),
    avg_cost_per_entity: round2(totalCost / entities),
    completion_rate: round2((completed / rows.length) * 100),
    rejection_rate: round2((rejected / rows.length) * 100),
    avg_automatable_wait_pct: round2(waitPcts.reduce((a, b) => a + b, 0) / waitPcts.length),
    fax_first_attempt_success_rate: faxRows.length ? round2((faxFirstOk / faxRows.length) * 100) : 0,
  };
}
