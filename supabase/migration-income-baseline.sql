-- Income Baseline & Snapshot — added 2026-05-13 for Enterprise Bank
-- post-funding income monitoring (Derek Le 2026-05-11 ask).
--
-- When a transcript pull completes, we extract the entity's income
-- figures (gross_receipts / total_income / total_tax / AGI) and persist
-- a snapshot. The FIRST pull for a given (client, TID) becomes the
-- baseline; subsequent pulls inherit that baseline and store their own
-- snapshot. The compliance status page renders a variance comparison
-- when both are present; material variance (>15%) triggers an email
-- alert to the client's loan officer / manager.
--
-- Both columns idempotent — safe to re-run.

ALTER TABLE public.request_entities
  ADD COLUMN IF NOT EXISTS income_baseline JSONB,
  ADD COLUMN IF NOT EXISTS income_snapshot JSONB;

COMMENT ON COLUMN public.request_entities.income_baseline IS
  'IncomeSnapshot captured at LOAN APPROVAL TIME. Set on the first pull for this (client, TID). Inherited by subsequent pulls (monitoring re-pulls + repeat-entity pulls). Used as the reconciliation reference point per Enterprise Bank Derek Le 2026-05-11 ask.';

COMMENT ON COLUMN public.request_entities.income_snapshot IS
  'IncomeSnapshot captured at THIS entity''s completion. For first pull, equals income_baseline. For subsequent pulls, compared against income_baseline to surface variance.';

-- Index for "find prior pulls for this TID under this client" lookup
CREATE INDEX IF NOT EXISTS request_entities_tid_client_completed_idx
  ON public.request_entities (tid)
  INCLUDE (request_id)
  WHERE income_snapshot IS NOT NULL;
