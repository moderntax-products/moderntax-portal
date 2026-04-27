-- Expert SLA Clock
--
-- Replaces the naive "now() + 24 hours" SLA model with a business-hours
-- clock that:
--   - Starts only when the 8821 is signed AND the assigned expert's
--     credentials are verified on the signed PDF (Phase 2: handled by
--     verification bot; Phase 1: set when entity transitions to
--     8821_signed as a close approximation).
--   - Skips Saturday and Sunday entirely.
--   - Runs only 7am–7pm in the expert's local IANA timezone.
--
-- Net effect: a 24-hour SLA = 12 business hours/day × 2 weekdays.
--
-- Idempotent — safe to re-run.

-- 1. Per-expert local timezone (used for the 7am–7pm window).
--    Default to Pacific because most ModernTax experts are West Coast;
--    each expert can override via /expert/profile.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS iana_timezone TEXT DEFAULT 'America/Los_Angeles';

COMMENT ON COLUMN public.profiles.iana_timezone IS
  'Expert''s local IANA timezone (e.g., America/Los_Angeles). Used by the SLA clock to compute the daily 7am–7pm business-hours window. DST applies — wall-clock based.';

-- 2. Per-assignment clock start + business-hours SLA budget.
ALTER TABLE public.expert_assignments
  ADD COLUMN IF NOT EXISTS expert_clock_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_business_hours INT DEFAULT 24;

COMMENT ON COLUMN public.expert_assignments.expert_clock_started_at IS
  'When the 8821 was signed AND verified to contain the assigned expert''s credentials (CAF, name, address, PTIN, phone). Null = clock has not yet started; assignment does not count toward overdue. Set by /api/webhook/dropbox-sign on signed-event after credential verification (Phase 2: bot-gated; Phase 1: set on 8821_signed transition).';

COMMENT ON COLUMN public.expert_assignments.sla_business_hours IS
  'SLA budget in business hours (Mon–Fri 7am–7pm in expert.iana_timezone). Default 24 = 2 business days. Replaces the legacy sla_deadline column for new logic; sla_deadline is kept for backward-compat reads.';

-- 3. Backfill existing assignments — use sla_deadline as a rough proxy:
--    if it's already past, set expert_clock_started_at to assigned_at; else null.
--    This is a one-time approximation so existing dashboards don't go blank.
UPDATE public.expert_assignments
SET expert_clock_started_at = assigned_at
WHERE expert_clock_started_at IS NULL
  AND sla_deadline < NOW()  -- only past-due rows; everything else stays null until properly verified
  AND status IN ('completed', 'failed');

-- 4. Index for the cron jobs that scan "active assignments with running clock"
CREATE INDEX IF NOT EXISTS idx_expert_assignments_clock_started
  ON public.expert_assignments(expert_clock_started_at)
  WHERE expert_clock_started_at IS NOT NULL
    AND status IN ('assigned', 'in_progress');
