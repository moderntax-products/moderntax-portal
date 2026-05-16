-- Request cancellation support — closes the bug Matt hit 2026-05-16
-- trying to cancel duplicate Growth Corp request c752233e (loan 8181909110).
--
-- Two failure modes the cancel API hit:
--   1. requests.status='cancelled' violated requests_status_check
--   2. requests.cancelled_at column did not exist (PGRST204)
--   3. expert_assignments.status='cancelled' would also violate its check
--      (not hit because the request UPDATE failed first)
--
-- This migration adds 'cancelled' to both CHECK constraints (preserving
-- all existing values) and adds cancelled_at + cancelled_by columns on
-- requests for audit trail. cancelled_by references profiles(id) so a
-- SOC 2 auditor can answer "who cancelled what, when, and why" (notes
-- column already captures the reason text).
--
-- Apply via: Supabase Dashboard → SQL Editor → paste + Run.

-- ---------------------------------------------------------------------------
-- 1. requests.status — add 'cancelled' (also adds 'pending' which is the
--    historical default but was missing from the original constraint; both
--    are observed in some legacy rows of related migrations).
-- ---------------------------------------------------------------------------
ALTER TABLE public.requests DROP CONSTRAINT IF EXISTS requests_status_check;
ALTER TABLE public.requests ADD CONSTRAINT requests_status_check
  CHECK (status IN (
    'pending',
    'submitted',
    '8821_sent',
    '8821_signed',
    'irs_queue',
    'processing',
    'completed',
    'failed',
    'cancelled'
  ));

-- ---------------------------------------------------------------------------
-- 2. requests.cancelled_at + cancelled_by (audit columns)
-- ---------------------------------------------------------------------------
ALTER TABLE public.requests ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE public.requests ADD COLUMN IF NOT EXISTS cancelled_by UUID
  REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Partial index — most rows are NULL; only the cancellations need indexing
-- for "show me all cancelled requests in the last 90 days" reports.
CREATE INDEX IF NOT EXISTS idx_requests_cancelled_at
  ON public.requests (cancelled_at)
  WHERE cancelled_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. expert_assignments.status — add 'cancelled' for the same reason
-- ---------------------------------------------------------------------------
ALTER TABLE public.expert_assignments DROP CONSTRAINT IF EXISTS expert_assignments_status_check;
ALTER TABLE public.expert_assignments ADD CONSTRAINT expert_assignments_status_check
  CHECK (status IN (
    'assigned',
    'in_progress',
    'completed',
    'failed',
    'reassigned',
    'cancelled'
  ));

-- ---------------------------------------------------------------------------
-- Verification queries:
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'public.requests'::regclass AND conname = 'requests_status_check';
--
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'requests' AND column_name IN ('cancelled_at', 'cancelled_by');
-- ---------------------------------------------------------------------------
