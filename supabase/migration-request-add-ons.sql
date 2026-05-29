-- Request-level add-ons (vs. entity-level which live on
-- request_entities.gross_receipts). Today: the Loan-Package Consolidation
-- Report SKU. Tomorrow: any other loan-level add-on (annual compliance
-- scan, portfolio insights, etc.) lands here as a new JSONB key.
--
-- Driver: 2026-05-28 product expansion — new $99 consolidation report SKU
-- is sold per-loan (not per-entity), so it needs to live on the request,
-- not on each entity. The auto-invoice cron walks this column to add the
-- loan-level line item.
--
-- Shape:
--   add_ons: {
--     loan_consolidation_report: {
--       selected: true,
--       price: 99.00,
--       sku: 'loan-consolidation-report',
--       selected_at: '2026-05-28T20:00:00Z'
--     },
--     // future add-ons go here
--   }

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS add_ons JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.requests.add_ons IS
  'Loan-level (request-level) add-on SKUs the processor opted into at intake. Keyed by SKU name. Walked by the auto-invoice cron to add per-loan line items.';
