-- Client credit balance — used by the auto-invoice cron to net payments
-- received outside the normal monthly cycle against the next invoice.
--
-- Driver: 2026-05-28 Matt — "Can you not just credit their balance so the
-- automated invoice does not double bill them on 5/31?" Specific trigger:
-- Cal Statewide ran a $659.78 ACH payment on the early INV-2026-05-CALI
-- before the end-of-month auto-invoice generated. Without intervention,
-- the 5/31 cron would produce a fresh invoice covering the same period
-- and double-bill them by ~$660.
--
-- Mechanism:
--   1. Outstanding credit lives on clients.outstanding_credit_balance.
--      Positive number = we owe them that much off their next invoice.
--   2. The auto-invoice cron reads the balance, subtracts min(balance,
--      grand_total) from the new invoice, and decrements the balance by
--      the amount consumed. Capped so we never produce a negative invoice.
--   3. invoices.credit_applied records how much was applied to that
--      specific invoice — audit trail.
--
-- General-purpose: same column powers any future "we owe them money"
-- scenario (refund-in-kind, prepay overage, accidental double payment, etc.).

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS outstanding_credit_balance NUMERIC(10, 2) NOT NULL DEFAULT 0;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS credit_applied NUMERIC(10, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.clients.outstanding_credit_balance IS
  'Unapplied credit we owe this client. Auto-invoice cron subtracts up to this amount off the next invoice and decrements the balance. Set via /api/admin/apply-client-credit or directly in Studio.';

COMMENT ON COLUMN public.invoices.credit_applied IS
  'Amount of clients.outstanding_credit_balance consumed on this specific invoice. Audit trail for "why is this invoice $X less than the line-item total?"';
