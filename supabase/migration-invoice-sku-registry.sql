-- Invoice SKU Registry — runtime lookup table for the Stripe IDs that
-- back each SKU in INVOICE_SKU_CATALOG (lib/pricing.ts). Populated by
-- scripts/register-invoice-skus.ts on every release where a SKU is added
-- or its price changes.
--
-- Why a DB table instead of an env var: Stripe Product/Price IDs are
-- opaque strings (prod_XXX, price_XXX) that vary between test mode and
-- live mode. Storing them in the DB lets us:
--   1. Look them up at runtime when composing a Stripe invoice / checkout
--      session ("which price_id is the current loan-consolidation-report?")
--   2. Track price-change history (the script archives stale prices and
--      writes the new one; this table always reflects the active price)
--   3. Avoid bloating the .env file with one var per SKU per environment
--
-- Driver: 2026-05-28 Matt — three new SKUs need to be billable through
-- both Stripe (card-pay customers) and Mercury (ACH-invoice customers).
-- Single source of truth (lib/pricing.ts INVOICE_SKU_CATALOG) →
-- registration script writes here → runtime queries read here.

CREATE TABLE IF NOT EXISTS public.invoice_sku_registry (
  sku                TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL,
  unit_price         NUMERIC(10, 2) NOT NULL,
  cadence            TEXT NOT NULL CHECK (cadence IN ('one_time', 'monthly')),
  unit               TEXT NOT NULL CHECK (unit IN ('entity', 'loan', 'enrollment', 'pack')),
  stripe_product_id  TEXT,
  stripe_price_id    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.invoice_sku_registry ENABLE ROW LEVEL SECURITY;

-- Public read for any authenticated portal user — the billing forecast
-- widget on the intake forms needs to pull current prices to render the
-- forecast. No PII; just product catalog.
DROP POLICY IF EXISTS invoice_sku_registry_authenticated_read ON public.invoice_sku_registry;
CREATE POLICY invoice_sku_registry_authenticated_read
  ON public.invoice_sku_registry FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Only the service role can write. The register-invoice-skus.ts script
-- uses the service-role key.
DROP POLICY IF EXISTS invoice_sku_registry_service_write ON public.invoice_sku_registry;
CREATE POLICY invoice_sku_registry_service_write
  ON public.invoice_sku_registry FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.invoice_sku_registry IS
  'Runtime lookup table for invoice SKUs. Authoritative copy lives in lib/pricing.ts INVOICE_SKU_CATALOG; this table caches the Stripe Product + Price IDs that back each SKU. Refreshed by scripts/register-invoice-skus.ts.';

COMMENT ON COLUMN public.invoice_sku_registry.cadence IS
  'one_time = single charge per use (verification, reorder, consolidation report). monthly = recurring charge until cancellation (post-close monitoring).';

COMMENT ON COLUMN public.invoice_sku_registry.unit IS
  'entity = priced per request_entities row. loan = priced per requests row. enrollment = priced per active monitoring enrollment per month. pack = priced per fixed bundle.';
