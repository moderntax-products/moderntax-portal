-- Add 'stripe' + 'card' to the invoices.payment_method enum constraint.
--
-- The original constraint (migration-invoices.sql) only allowed ('ach','wire'),
-- which was correct when Mercury was the sole billing channel. May 2026 we
-- introduced Stripe auto-charge for monitoring fees (recurring, low-dollar,
-- saved card on file) — those invoice rows need payment_method='stripe' so
-- the admin reports + per-client revenue rollups can attribute them
-- correctly without scanning paid_via for every row.
--
-- This drops + recreates the constraint to widen the allowed set.
-- Idempotent: safe to re-run.

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_payment_method_check;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_payment_method_check
  CHECK (payment_method IS NULL OR payment_method IN ('ach', 'wire', 'stripe', 'card'));

COMMENT ON COLUMN public.invoices.payment_method IS
  'How the invoice is billed: ach=Mercury ACH Debit invoice, wire=Mercury wire request, stripe=Stripe off_session card charge, card=Stripe checkout link. NULL = unset (legacy or pending classification).';
