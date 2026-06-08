-- Client prepaid credits (2026-06-06)
--
-- New billing model for standard-plan clients: they pre-buy credits (a USD
-- wallet) and each transcript request debits a per-request rate from the
-- balance. The rate is discounted by how much they pre-purchased:
--   • standard / no prepay        → $99.99 / request
--   • $1,000+ credit purchase     → $59.99 / request (40% off)
--   • $2,000+ credit purchase     → $39.99 / request (60% off)
--
-- Apply in Supabase Studio (SQL editor). Idempotent.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS credit_balance         numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credit_rate            numeric(12,2) NOT NULL DEFAULT 99.99,
  ADD COLUMN IF NOT EXISTS credit_purchased_total numeric(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.clients.credit_balance IS 'Prepaid credit wallet (USD). Each request debits credit_rate.';
COMMENT ON COLUMN public.clients.credit_rate IS 'Per-request debit rate locked in by the best credit pack purchased (99.99 default, 59.99 @ $1k, 39.99 @ $2k).';
COMMENT ON COLUMN public.clients.credit_purchased_total IS 'Lifetime USD of credits purchased (drives tier + reporting).';

-- Per-entity flag so the Mercury invoice cron never double-bills an entity that
-- was already paid from the credit wallet.
ALTER TABLE public.request_entities
  ADD COLUMN IF NOT EXISTS credit_paid boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.request_entities.credit_paid IS 'TRUE once this entity was debited from the client credit wallet — excluded from Mercury invoicing.';

-- Ledger of credit movements (purchases + debits) for audit + receipts.
CREATE TABLE IF NOT EXISTS public.credit_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('purchase', 'debit', 'adjustment', 'refund')),
  amount      numeric(12,2) NOT NULL,           -- +purchase / -debit
  balance_after numeric(12,2) NOT NULL,
  entity_id   uuid REFERENCES public.request_entities(id) ON DELETE SET NULL,
  stripe_ref  text,                             -- checkout session / payment intent id
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: one purchase row per Stripe checkout session.
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_stripe_ref_uniq
  ON public.credit_ledger (stripe_ref) WHERE stripe_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS credit_ledger_client_idx ON public.credit_ledger (client_id, created_at DESC);
