-- Trial Qualification Gate — June 2026
-- Adds qualification columns to profiles + clients.
-- Kill criteria live in lib/trial-score.ts (server-side).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS qual_segment TEXT,
  ADD COLUMN IF NOT EXISTS qual_monthly_volume TEXT,
  ADD COLUMN IF NOT EXISTS qual_current_vendor TEXT,
  ADD COLUMN IF NOT EXISTS qual_team_size TEXT,
  ADD COLUMN IF NOT EXISTS qual_use_case_text TEXT,
  ADD COLUMN IF NOT EXISTS qual_score TEXT DEFAULT 'unscored';

DO $$ BEGIN
  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_qual_segment_check
    CHECK (qual_segment IS NULL OR qual_segment IN (
      'sba_lender_bank','sba_lender_cdc','commercial_bank',
      'fintech_originator','accountant_cpa','individual_borrower',
      'insurance','employment_verif','other'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_qual_score_check
    CHECK (qual_score IN ('unscored','auto_qualified','manual_review','disqualified'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS trial_segment TEXT,
  ADD COLUMN IF NOT EXISTS trial_monthly_volume_range TEXT,
  ADD COLUMN IF NOT EXISTS trial_current_vendor TEXT,
  ADD COLUMN IF NOT EXISTS trial_qualified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_disqualified_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_profiles_qual_pending
  ON public.profiles(created_at)
  WHERE approval_status = 'pending';

COMMENT ON COLUMN public.profiles.qual_segment IS 'ICP segment selected at signup. Drives auto-qualify vs manual-review vs disqualify.';
COMMENT ON COLUMN public.profiles.qual_monthly_volume IS 'Self-reported monthly transcript volume bracket.';
COMMENT ON COLUMN public.profiles.qual_score IS 'unscored | auto_qualified | manual_review | disqualified. Set by /api/auth/signup.';
COMMENT ON COLUMN public.clients.trial_segment IS 'Copied from profiles.qual_segment at approval time.';
COMMENT ON COLUMN public.clients.trial_current_vendor IS 'Copied from profiles.qual_current_vendor. Displacement intelligence.';
