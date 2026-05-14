-- Migration: Add fiscal_year_end_month to request_entities
--
-- Driver: Katie Lent at Growth Corp had her prior vendor pull transcripts
-- with the wrong fiscal year end (12/31 calendar) when her entity actually
-- files on a 2/28 fiscal year. This created stale, unusable transcripts
-- and required a vendor swap mid-flow.
--
-- Without this column, the only way to communicate FYE to the expert is
-- via the request's free-text `notes` field, which doesn't auto-derive
-- period_ending dates and easily gets missed.
--
-- Semantics:
--   NULL or 12  → calendar year (default). Year 2024 = period ending 12-31-2024.
--   1-11        → fiscal year ending in that month. For year 2024 with FYE month 2:
--                 period ending = 02-{lastDayOfFeb2025}-2025 (one calendar year
--                 AFTER the fiscal year integer in IRS notation).
--
-- Form 941 always uses calendar quarters regardless of FYE — this field is
-- only consulted for 1040 / 1065 / 1120 / 1120S returns.

ALTER TABLE public.request_entities
  ADD COLUMN IF NOT EXISTS fiscal_year_end_month SMALLINT
    CHECK (fiscal_year_end_month IS NULL OR (fiscal_year_end_month >= 1 AND fiscal_year_end_month <= 12));

COMMENT ON COLUMN public.request_entities.fiscal_year_end_month IS
  'Month (1-12) of the entity''s fiscal year end. NULL or 12 means calendar year. Drives period_ending derivation for income-tax form pulls (1040/1065/1120/1120S).';

CREATE INDEX IF NOT EXISTS idx_request_entities_fiscal_year_end
  ON public.request_entities(fiscal_year_end_month)
  WHERE fiscal_year_end_month IS NOT NULL AND fiscal_year_end_month <> 12;
