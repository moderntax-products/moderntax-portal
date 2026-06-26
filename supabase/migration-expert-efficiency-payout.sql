-- Margin-guard payout engine (Matt 2026-06-26 PRD).
--
-- Adds the efficiency + cap-protected-payout fields to expert_pay_periods and a
-- 'blocked' lifecycle state for zero-production periods (which must never be
-- 'approved', so they can never be drafted/paid).
--
-- BASE_HOURLY_RATE $45 (per-expert configurable) · MAX_COST_PER_TIN $32.99
-- ($59.98 min client bill − 45% target margin) · MIN_EFFICIENCY_TARGET 5 TINs/hr.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.expert_pay_periods
  ADD COLUMN IF NOT EXISTS efficiency_rate NUMERIC(6,2) NOT NULL DEFAULT 0,   -- TINs/hr
  ADD COLUMN IF NOT EXISTS hourly_gross    NUMERIC(10,2) NOT NULL DEFAULT 0,  -- hours × rate (uncapped)
  ADD COLUMN IF NOT EXISTS piece_rate_cap  NUMERIC(10,2) NOT NULL DEFAULT 0,  -- tins × MAX_COST_PER_TIN
  ADD COLUMN IF NOT EXISTS payout_status   TEXT NOT NULL DEFAULT 'PENDING_REVIEW';

COMMENT ON COLUMN public.expert_pay_periods.efficiency_rate IS 'Throughput in TINs/hour for the period (tins ÷ hours). Drives work-routing tiers.';
COMMENT ON COLUMN public.expert_pay_periods.payout_status IS 'Margin-guard engine result: PENDING_REVIEW | APPROVED_FOR_PAYMENT | BLOCKED_ZERO_PRODUCTION | CAP_OVERRIDE_TRIGGERED.';
COMMENT ON COLUMN public.expert_pay_periods.piece_rate_cap IS 'Per-TIN margin cap (tins × $32.99). When hourly_gross exceeds it, gross_pay is capped to this and payout_status=CAP_OVERRIDE_TRIGGERED.';

-- Constrain payout_status to the PRD enum.
ALTER TABLE public.expert_pay_periods DROP CONSTRAINT IF EXISTS expert_pay_periods_payout_status_check;
ALTER TABLE public.expert_pay_periods ADD CONSTRAINT expert_pay_periods_payout_status_check
  CHECK (payout_status IN ('PENDING_REVIEW','APPROVED_FOR_PAYMENT','BLOCKED_ZERO_PRODUCTION','CAP_OVERRIDE_TRIGGERED'));

-- Add 'blocked' to the lifecycle status (zero-production never reaches 'approved').
ALTER TABLE public.expert_pay_periods DROP CONSTRAINT IF EXISTS expert_pay_periods_status_check;
ALTER TABLE public.expert_pay_periods ADD CONSTRAINT expert_pay_periods_status_check
  CHECK (status IN ('pending','approved','paid','partial','cancelled','blocked'));
