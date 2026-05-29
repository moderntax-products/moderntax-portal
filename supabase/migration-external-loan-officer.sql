-- External loan officer attribution for API-sourced requests.
--
-- Driver: 2026-05-29 Matt — Clearfirm dashboard showed "Loan Officer:
-- Unknown" across all 49 API-sourced requests because every request's
-- requested_by points to the admin who provisioned the API key (matt@
-- moderntax.io for Clearfirm), not the loan officer who actually
-- originated the request inside Clearfirm's LOS.
--
-- Approach: store the loan officer's name + email as free-text fields
-- on the request row. We deliberately do NOT try to resolve the email
-- to a profiles row — these officers don't have ModernTax accounts,
-- they live in Clearfirm's system. Free-text gives us attribution on
-- the dashboard + breakdown table + invoice PDF without forcing
-- account provisioning we don't actually need.
--
-- Both columns are optional. Existing rows + non-API intakes ignore
-- them; the dashboard render falls back to profiles.full_name (the
-- requested_by user) when these fields are null.

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS external_loan_officer_name  TEXT,
  ADD COLUMN IF NOT EXISTS external_loan_officer_email TEXT;

COMMENT ON COLUMN public.requests.external_loan_officer_name IS
  'Free-text loan officer name passed by an API partner at request creation. Used for dashboard attribution + invoice PDF rollup. NULL when the intake is non-API or the partner did not pass the field. Does NOT need to match a profiles row.';

COMMENT ON COLUMN public.requests.external_loan_officer_email IS
  'Free-text loan officer email passed by an API partner at request creation. Used as a secondary attribution key in the manager dashboard breakdown table. NULL when the intake is non-API or the partner did not pass the field.';
