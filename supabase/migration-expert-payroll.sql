-- Expert payroll: time logs + pay periods + per-expert pay config
--
-- Modelled on the LaTonya timesheet (calculatednumbers — Tonya CSV):
--   - Hourly pay at $45/hr (configurable per expert).
--   - Target throughput = 5 TINs/hr (configurable). Bumped from the
--     legacy 3.333 (5 TINs / 1.5 hr) once IRS Direct Sync removed the
--     per-transcript manual upload step.
--   - Bi-weekly pay periods, payments via Stripe Connect.
--   - Efficiency = TINs completed / (hours × target rate).
--   - SLA-met % = subset of TINs that completed within their SLA budget
--     (uses lib/expert-sla business-hours math).
--
-- Tables:
--   expert_time_logs     — one row per work session (clock-in to clock-out)
--   expert_pay_periods   — one row per pay period per expert (rolled up from logs)
--
-- Idempotent — safe to re-run.

-- 1. Per-expert pay config on profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS hourly_rate           NUMERIC(8,2) DEFAULT 45.00,
  ADD COLUMN IF NOT EXISTS target_tins_per_hour  NUMERIC(6,3) DEFAULT 5.000,
  ADD COLUMN IF NOT EXISTS payment_method        TEXT         DEFAULT 'stripe_connect',
  ADD COLUMN IF NOT EXISTS stripe_connect_id     TEXT,
  ADD COLUMN IF NOT EXISTS expert_trial_start    DATE;

-- Bump existing experts from the legacy 3.333 default (5 TINs/1.5hr) to
-- 5.0 (5 TINs/hr). Rationale: the IRS Direct Sync script removed the
-- per-transcript manual upload step, so per-hour throughput should
-- land in the 4–5 unique entities range. Admin can override per expert
-- via /admin/payroll if a specific expert needs a different target.
UPDATE public.profiles
SET target_tins_per_hour = 5.000
WHERE role = 'expert'
  AND (target_tins_per_hour IS NULL OR target_tins_per_hour = 3.333);

COMMENT ON COLUMN public.profiles.hourly_rate IS 'Expert hourly rate (default $45.00). Overridable per expert.';
COMMENT ON COLUMN public.profiles.target_tins_per_hour IS 'Target throughput in TINs/hour (default 5.0). Used to compute the efficiency %. Bumped from the original 3.333 (5/1.5hr) once SOR sync removed the manual-upload step.';
COMMENT ON COLUMN public.profiles.payment_method IS '"stripe_connect" (default) or "manual". stripe_connect_id is the Connect account if applicable.';

-- 2. Time logs — one row per work session
CREATE TABLE IF NOT EXISTS public.expert_time_logs (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  expert_id       UUID         NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- A session can be open (end_at NULL) while the expert is clocked in.
  start_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  end_at          TIMESTAMPTZ,
  break_minutes   INT          NOT NULL DEFAULT 0,
  -- Computed at clock-out for fast queries; falls back to NOW() - start_at for open sessions.
  hours_worked    NUMERIC(6,2),
  -- Auto-counted at clock-out: how many request_entities transitioned to
  -- 'completed' for this expert during [start_at, end_at]. Editable by
  -- admin if the auto-count misses something.
  tins_completed  INT          NOT NULL DEFAULT 0,
  notes           TEXT,
  pay_period_id   UUID,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT expert_time_logs_end_after_start CHECK (end_at IS NULL OR end_at >= start_at)
);

CREATE INDEX IF NOT EXISTS idx_expert_time_logs_expert_active
  ON public.expert_time_logs(expert_id)
  WHERE end_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_expert_time_logs_expert_window
  ON public.expert_time_logs(expert_id, start_at DESC);
CREATE INDEX IF NOT EXISTS idx_expert_time_logs_pay_period
  ON public.expert_time_logs(pay_period_id)
  WHERE pay_period_id IS NOT NULL;

-- 3. Pay periods — one row per (expert, period). Created on demand by the
--    rollover cron OR manually by an admin via the payroll UI.
CREATE TABLE IF NOT EXISTS public.expert_pay_periods (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  expert_id           UUID         NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  period_start        DATE         NOT NULL,
  period_end          DATE         NOT NULL,
  pay_date            DATE         NOT NULL,
  hourly_rate         NUMERIC(8,2) NOT NULL,
  target_tins_per_hour NUMERIC(6,3) NOT NULL,
  -- Rolled-up totals from expert_time_logs in [period_start, period_end].
  -- Recomputed on demand; can drift while the period is open (status='pending').
  total_hours         NUMERIC(8,2) NOT NULL DEFAULT 0,
  total_tins          INT          NOT NULL DEFAULT 0,
  expected_tins       NUMERIC(8,2) NOT NULL DEFAULT 0,
  efficiency_pct      NUMERIC(5,2) NOT NULL DEFAULT 0,
  -- SLA-compliance % across the TINs counted in this period (computed
  -- using lib/expert-sla business-hours clock).
  sla_met_pct         NUMERIC(5,2),
  gross_pay           NUMERIC(10,2) NOT NULL DEFAULT 0,
  status              TEXT         NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'paid', 'partial', 'cancelled')
  ),
  paid_at             TIMESTAMPTZ,
  paid_by             UUID         REFERENCES public.profiles(id),
  payment_reference   TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT expert_pay_periods_unique_per_expert UNIQUE (expert_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_expert_pay_periods_expert
  ON public.expert_pay_periods(expert_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_expert_pay_periods_pending
  ON public.expert_pay_periods(pay_date)
  WHERE status IN ('pending', 'approved');

-- 4. RLS — experts read own logs + periods; admins read all.
ALTER TABLE public.expert_time_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expert_pay_periods ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Experts read own time logs"
    ON public.expert_time_logs FOR SELECT
    USING (expert_id = auth.uid() OR public.get_my_role() = 'admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Experts insert own time logs"
    ON public.expert_time_logs FOR INSERT
    WITH CHECK (expert_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Experts update own time logs"
    ON public.expert_time_logs FOR UPDATE
    USING (expert_id = auth.uid() OR public.get_my_role() = 'admin')
    WITH CHECK (expert_id = auth.uid() OR public.get_my_role() = 'admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Experts read own pay periods"
    ON public.expert_pay_periods FOR SELECT
    USING (expert_id = auth.uid() OR public.get_my_role() = 'admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Admins manage pay periods"
    ON public.expert_pay_periods FOR ALL
    USING (public.get_my_role() = 'admin')
    WITH CHECK (public.get_my_role() = 'admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
