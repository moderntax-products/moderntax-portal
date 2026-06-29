-- Card-per-order billing (#3, 2026-06-28): same-day per-order invoices charged
-- to a client's saved card, replacing monthly net-30 Mercury invoicing for
-- clients who opt in. Idempotent — safe to re-run.

-- 1. Client billing mode. Default keeps every existing client on monthly ACH.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'mercury_net30';
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_billing_mode_check;
ALTER TABLE public.clients ADD CONSTRAINT clients_billing_mode_check
  CHECK (billing_mode IN ('mercury_net30','card_per_order'));
COMMENT ON COLUMN public.clients.billing_mode IS
  'mercury_net30 = monthly ACH invoice, net terms (default). card_per_order = same-day Stripe charge on the saved card as each order completes; these clients are EXCLUDED from the monthly Mercury invoice crons so they are never double-billed.';

-- 2. Per-order invoice fields.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS entity_id UUID REFERENCES public.request_entities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS invoice_kind TEXT NOT NULL DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS stripe_payment_link_url TEXT;
COMMENT ON COLUMN public.invoices.invoice_kind IS 'monthly = period roll-up invoice. per_order = single completed-order same-day charge (entity_id set).';

-- 3. Widen status to include payment_failed (declined card → handed to dunning).
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('draft','sent','paid','overdue','payment_failed'));

-- 4. The table is uniquely keyed per billing PERIOD — correct for monthly
--    invoices, but it blocks more than one per-order invoice per client per day.
--    Relax it: keep period-uniqueness ONLY for period invoices (entity_id NULL),
--    and enforce one invoice per entity for per-order invoices.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
  WHERE conrelid = 'public.invoices'::regclass AND contype = 'u'
    AND pg_get_constraintdef(oid) LIKE '%billing_period_start%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE public.invoices DROP CONSTRAINT %I', c); END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_period_per_client
  ON public.invoices(client_id, billing_period_start, billing_period_end)
  WHERE entity_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_per_entity
  ON public.invoices(entity_id) WHERE entity_id IS NOT NULL;
