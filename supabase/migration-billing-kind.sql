-- Distinguishes auto-cron-generated invoices from manager-triggered "Pay Now"
-- invoices. The /api/billing/pay-now endpoint stamps `billing_kind='manual'`
-- so we can avoid creating duplicate manual invoices in the same month
-- (idempotency guard) while still letting the 1st-of-month cron run normally.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS billing_kind TEXT DEFAULT 'auto';

COMMENT ON COLUMN public.invoices.billing_kind IS
  '"auto" for cron-generated invoices (the default — fired on the 1st of each month); "manual" for invoices created via the /api/billing/pay-now Pay Now flow.';

-- Backfill: every existing invoice was auto-generated.
UPDATE public.invoices SET billing_kind = 'auto' WHERE billing_kind IS NULL;
