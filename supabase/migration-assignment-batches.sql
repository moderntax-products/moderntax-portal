-- Supply-demand expert acceptance workflow (Matt directive 2026-05-16).
--
-- New flow:
--   1. Batch of 3-5 entities offered to a credentialed expert
--   2. Expert has 30 minutes to accept; otherwise batch returns to pool
--   3. On accept: 8821 PDFs regen'd with that expert's CAF/PTIN, attached
--      to the per-entity assignment (Joel-stuck-with-LaTonya's-CAF class
--      of failure is structurally impossible after this)
--   4. Expert has 24 hours from accept to complete the batch
--
-- Apply via: Supabase Dashboard → SQL Editor → paste + Run.

-- ---------------------------------------------------------------------------
-- 1. assignment_batches — the offer + lifecycle envelope
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.assignment_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expert_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- Lifecycle status
  status TEXT NOT NULL DEFAULT 'pending_acceptance' CHECK (
    status IN (
      'pending_acceptance', -- offered, awaiting expert click
      'accepted',           -- expert accepted, work in progress
      'declined',           -- expert explicitly declined
      'expired',            -- 30-min acceptance window passed
      'completed',          -- all assignments in batch completed
      'cancelled'           -- admin cancelled the offer
    )
  ),

  -- Acceptance window (30 min)
  offered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acceptance_deadline TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,

  -- Completion window (24 hours from accept)
  completion_deadline TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- Context
  offered_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  decline_reason TEXT,
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Find pending batches expiring soon (cron query)
CREATE INDEX IF NOT EXISTS idx_assignment_batches_pending_deadline
  ON public.assignment_batches (acceptance_deadline)
  WHERE status = 'pending_acceptance';

-- Find an expert's current pending batch (expert dashboard query)
CREATE INDEX IF NOT EXISTS idx_assignment_batches_expert_status
  ON public.assignment_batches (expert_id, status)
  WHERE status IN ('pending_acceptance', 'accepted');

-- ---------------------------------------------------------------------------
-- 2. expert_assignments.batch_id — link each per-entity assignment to a batch
-- ---------------------------------------------------------------------------
ALTER TABLE public.expert_assignments
  ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES public.assignment_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expert_assignments_batch_id
  ON public.expert_assignments (batch_id)
  WHERE batch_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Extend expert_assignments.status to cover the batch lifecycle states
-- ---------------------------------------------------------------------------
ALTER TABLE public.expert_assignments DROP CONSTRAINT IF EXISTS expert_assignments_status_check;
ALTER TABLE public.expert_assignments ADD CONSTRAINT expert_assignments_status_check
  CHECK (status IN (
    'pending_acceptance', -- offered as part of a batch, awaiting accept
    'assigned',           -- batch accepted, work can begin
    'in_progress',        -- expert started
    'completed',          -- expert completed
    'failed',             -- expert flagged issue
    'reassigned',         -- swapped to another expert
    'cancelled',          -- terminal admin cancel
    'declined',           -- expert explicitly declined (rare — usually via batch)
    'expired'             -- 30-min acceptance window passed
  ));

-- ---------------------------------------------------------------------------
-- 4. expert_regenerated_8821_url — where the post-acceptance 8821 lives
--    (separate from signed_8821_url which holds the original borrower-signed
--    PDF so we have an audit trail of both designees)
-- ---------------------------------------------------------------------------
ALTER TABLE public.request_entities
  ADD COLUMN IF NOT EXISTS expert_regenerated_8821_url TEXT;

-- ---------------------------------------------------------------------------
-- 5. updated_at trigger on assignment_batches
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_assignment_batches_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS assignment_batches_updated_at ON public.assignment_batches;
CREATE TRIGGER assignment_batches_updated_at
  BEFORE UPDATE ON public.assignment_batches
  FOR EACH ROW EXECUTE FUNCTION trg_assignment_batches_updated_at();

-- ---------------------------------------------------------------------------
-- 6. RLS — service-role bypass for all server-side flows; default-deny otherwise
-- ---------------------------------------------------------------------------
ALTER TABLE public.assignment_batches ENABLE ROW LEVEL SECURITY;
-- Per-tenant policies deferred (MOD-186 follow-up) — same posture as the
-- other Phase-2 RLS-on-no-policies tables.
