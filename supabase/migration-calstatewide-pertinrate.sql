-- California Statewide CDC: per-TIN rate is $79.98 regardless of intake
-- method (per the 2026-04-21 MSA). The schema separates billing_rate_pdf
-- and billing_rate_csv to support clients with method-tiered pricing,
-- but Cal Statewide uses a single flat per-TIN rate, so set both to
-- $79.98.
--
-- Without this fix:
--   - The /admin/billing page shows them at the default $59.98 PDF rate
--     (3 free trial entities at $179.94 instead of the $239.94 trial
--     credit value displayed in the manager dashboard banner).
--   - The auto-invoice cron would bill them under-rate on the first
--     paid (post-trial) invoice.
--
-- Idempotent — safe to re-run.

UPDATE public.clients
SET billing_rate_pdf = 79.98,
    billing_rate_csv = 79.98
WHERE id = '3256293c-6c98-42bc-a828-2b73a603048e'  -- California Statewide CDC
  AND billing_model = 'per_tin';
