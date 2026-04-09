-- 8821 Rejection Reason Codes
-- Expands irs_call_entities.outcome with granular 8821 failure codes
-- Adds rejection_detail JSONB for structured correction info

-- 1. Drop old CHECK constraint and add expanded one
ALTER TABLE public.irs_call_entities
  DROP CONSTRAINT IF EXISTS irs_call_entities_outcome_check;

ALTER TABLE public.irs_call_entities
  ADD CONSTRAINT irs_call_entities_outcome_check CHECK (
    outcome IN (
      -- Success outcomes
      'transcripts_requested', 'transcripts_verbal',
      'fax_sent', 'pending_callback', 'skipped',
      -- 8821 rejection reasons (needs resubmission)
      'bad_address', 'wrong_ein', 'wrong_ssn',
      'wrong_business_name', 'wrong_taxpayer_name',
      'missing_tax_years', 'wrong_form_type',
      'caf_not_on_file', 'no_8821_on_file', '8821_esig_rejected',
      -- Legacy codes (kept for existing data)
      'name_mismatch', 'taxpayer_not_found',
      -- Other
      'other'
    )
  );

-- 2. Add rejection_detail JSONB column for structured correction data
-- Stores: { field: "address", irs_said: "123 Wrong St", correct_value: "456 Right St", agent_name: "Mrs. Irwin", agent_badge: "12345" }
ALTER TABLE public.irs_call_entities
  ADD COLUMN IF NOT EXISTS rejection_detail JSONB;

-- 3. Add needs_resubmission flag to expert_assignments
-- When true, the 8821 needs to be corrected and refiled
ALTER TABLE public.expert_assignments
  ADD COLUMN IF NOT EXISTS needs_resubmission BOOLEAN DEFAULT FALSE;

ALTER TABLE public.expert_assignments
  ADD COLUMN IF NOT EXISTS resubmission_reason TEXT;

-- 4. Index for finding assignments that need resubmission
CREATE INDEX IF NOT EXISTS idx_expert_assignments_resubmission
  ON public.expert_assignments(needs_resubmission)
  WHERE needs_resubmission = TRUE;
