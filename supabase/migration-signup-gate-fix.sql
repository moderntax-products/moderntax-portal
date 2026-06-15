-- Sign-up approval gate — production fix.
--
-- The signup flow + /admin/pending-signups depend on profile columns that were
-- never added in prod (approval_status, title, use_case, etc.). So every signup
-- silently failed to persist its qualification data and never showed as pending.
-- This adds the columns, grandfathers existing users to 'approved' (so they're
-- not locked out by the new gate), and restores the one stranded signup
-- (Ismaeel Orabi / PetitionHQ) to 'pending' so it lands in the admin queue.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS referral_source TEXT,
  ADD COLUMN IF NOT EXISTS use_case TEXT,
  ADD COLUMN IF NOT EXISTS use_case_other TEXT,
  ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS approval_rejected_reason TEXT;

DO $$ BEGIN
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_approval_status_check
    CHECK (approval_status IN ('pending', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_use_case_check
    CHECK (use_case IS NULL OR use_case IN ('sba', 'employment', 'insurance', 'other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Grandfather every existing user to 'approved' (they're already active — the
-- new 'pending' default must not lock them out).
UPDATE public.profiles
SET approval_status = 'approved',
    approved_at = COALESCE(approved_at, created_at, NOW())
WHERE approval_status IS NULL OR approval_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_profiles_approval_pending
  ON public.profiles(created_at) WHERE approval_status = 'pending';

-- Restore the stranded signup to 'pending' with its qualification data (from its
-- signup audit row) so admin can review + approve/reject it normally.
UPDATE public.profiles SET
  role = 'manager',
  approval_status = 'pending',
  approved_at = NULL,
  title = 'Founder',
  use_case = 'other',
  referral_source = 'search',
  use_case_other = 'B2B software for law firms: our platform prepares legal filings and gathers each client''s financial records during intake with their consent. We need API-based individual transcript pulls (1040 return).'
WHERE id = '4be91619-f940-41f9-b566-b645390afa2f';
