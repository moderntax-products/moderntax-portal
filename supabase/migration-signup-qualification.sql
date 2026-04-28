-- Sign-up qualification + admin approval gate
--
-- Two changes:
--   1. Capture lead-qualification data at sign-up (referral source +
--      use case + optional write-in) so admin can vet before granting
--      access.
--   2. Add an approval_status gate so new sign-ups land in 'pending'
--      and can't access the portal until an admin assigns a client +
--      approves. Existing users grandfathered to 'approved'.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS referral_source TEXT,
  ADD COLUMN IF NOT EXISTS use_case TEXT,
  ADD COLUMN IF NOT EXISTS use_case_other TEXT,
  ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS approval_rejected_reason TEXT;

-- Constrain approval_status to a known set
DO $$ BEGIN
  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_approval_status_check
    CHECK (approval_status IN ('pending', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Constrain use_case to the known options (other = write-in)
DO $$ BEGIN
  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_use_case_check
    CHECK (use_case IS NULL OR use_case IN ('sba', 'employment', 'insurance', 'other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Grandfather every existing user — they're already in the system, so
-- they're approved. Only NEW sign-ups land in 'pending'.
UPDATE public.profiles
SET approval_status = 'approved',
    approved_at = COALESCE(approved_at, created_at, NOW())
WHERE approval_status IS NULL OR approval_status = 'pending';

-- Index for the admin queue ("show me pending sign-ups oldest first")
CREATE INDEX IF NOT EXISTS idx_profiles_approval_pending
  ON public.profiles(created_at)
  WHERE approval_status = 'pending';

COMMENT ON COLUMN public.profiles.referral_source IS
  'How the prospect found ModernTax (free text or dropdown choice). Captured at sign-up.';
COMMENT ON COLUMN public.profiles.use_case IS
  'Primary use case at sign-up: sba | employment | insurance | other. NULL for grandfathered users.';
COMMENT ON COLUMN public.profiles.use_case_other IS
  'Free-text write-in when use_case = ''other''.';
COMMENT ON COLUMN public.profiles.approval_status IS
  '''pending'' = awaiting admin approval (cannot access portal). ''approved'' = active. ''rejected'' = denied. New sign-ups default to pending; existing users grandfathered to approved by the migration.';
