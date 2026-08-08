-- PPS Call Meter — Metered AI Call pilot (Build Spec v0.1, week of 2026-07-20)
-- Instruments real IRS PPS calls end-to-end to prove/kill the $18.49/entity
-- unit-cost assumption. Phase 0 automates ONLY the waiting; this table captures
-- the time decomposition + derived cost for every call.
--
-- SECURITY (§5): NO authenticating PII lives here — no SSN/DOB/CAF. We meter
-- with timestamps + event durations, not audio, until recording-consent is
-- resolved with counsel. Redacted notes only.

CREATE TABLE IF NOT EXISTS public.pps_call_meter (
  call_id             UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  client              TEXT        NOT NULL,   -- 'centerstone' | 'cal_statewide'
  request_id          TEXT,                   -- e.g. 18058
  entity_ids          TEXT[],                 -- multiple entities per call
  entities_on_call    INT         NOT NULL,

  -- time decomposition (seconds)
  dial_to_ivr_sec     INT,
  ivr_nav_sec         INT,
  queue_wait_sec      INT,                    -- pre-agent, fully automatable
  total_hold_sec      INT,                    -- mid-call holds, fully automatable
  active_talk_sec     INT,
  human_attached_sec  INT         NOT NULL,   -- ** THE MONEY METRIC **
  total_call_sec      INT         NOT NULL,

  -- cost
  ai_minutes          NUMERIC,
  ai_cost_usd         NUMERIC,                -- ai_minutes * rate
  human_cost_usd      NUMERIC,                -- human_attached_sec/3600 * 45.00
  fax_cost_usd        NUMERIC,
  total_cost_usd      NUMERIC,

  -- fax reliability
  fax_sent_at         TIMESTAMPTZ,
  fax_confirmed_at    TIMESTAMPTZ,
  fax_retries         INT         DEFAULT 0,

  -- outcome
  outcome             TEXT        NOT NULL,   -- completed|irs_rejected|disconnected|escalated|agent_refused
  rejection_reason    TEXT,
  transcripts_ordered JSONB,                  -- forms, periods, counts
  escalation_trigger  TEXT,
  notes               TEXT,

  -- operator + phase context (not in the v0.1 spec but needed to segment data)
  operator_id         UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  phase               TEXT        DEFAULT 'manual',  -- manual|phase0|phase1|phase2
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE public.pps_call_meter
    ADD CONSTRAINT pps_call_meter_client_check
    CHECK (client IN ('centerstone','cal_statewide'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.pps_call_meter
    ADD CONSTRAINT pps_call_meter_outcome_check
    CHECK (outcome IN ('completed','irs_rejected','disconnected','escalated','agent_refused'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.pps_call_meter
    ADD CONSTRAINT pps_call_meter_phase_check
    CHECK (phase IN ('manual','phase0','phase1','phase2'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_pps_meter_started   ON public.pps_call_meter(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pps_meter_client    ON public.pps_call_meter(client, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pps_meter_phase     ON public.pps_call_meter(phase, started_at DESC);

ALTER TABLE public.pps_call_meter ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pps_call_meter_admin_all ON public.pps_call_meter;
CREATE POLICY pps_call_meter_admin_all ON public.pps_call_meter
  FOR ALL USING (
    auth.role() = 'service_role' OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

COMMENT ON TABLE public.pps_call_meter IS
  'Metered AI Call pilot — per-call time decomposition + derived cost. human_attached_sec is the money metric vs the 51.3 min/entity baseline. No PII.';
