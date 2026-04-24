-- Mercury invoicing integration + net-5 billing terms
-- Runs once. Safe to re-run (IF NOT EXISTS guards).
--
-- Ties:
--   MOD-205 / MOD-206 / MOD-207 — Mercury API replaces the manual invoice-send step.

-- Clients: track Mercury customer id + per-client invoice terms
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS mercury_customer_id UUID,
  ADD COLUMN IF NOT EXISTS billing_net_days    INT DEFAULT 5,
  ADD COLUMN IF NOT EXISTS billing_rate_monitoring NUMERIC DEFAULT 25.00,
  ADD COLUMN IF NOT EXISTS address_line1       TEXT,
  ADD COLUMN IF NOT EXISTS address_line2       TEXT,
  ADD COLUMN IF NOT EXISTS address_city        TEXT,
  ADD COLUMN IF NOT EXISTS address_state       TEXT,
  ADD COLUMN IF NOT EXISTS address_postal_code TEXT,
  ADD COLUMN IF NOT EXISTS address_country     TEXT DEFAULT 'US';

-- All existing clients default to net-5 per new standard policy.
UPDATE public.clients SET billing_net_days = 5 WHERE billing_net_days IS NULL;

-- Invoices: store Mercury invoice id/slug + pay URL + monitoring breakdown
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS mercury_invoice_id     UUID,
  ADD COLUMN IF NOT EXISTS mercury_invoice_slug   TEXT,
  ADD COLUMN IF NOT EXISTS mercury_pay_url        TEXT,
  ADD COLUMN IF NOT EXISTS mercury_pdf_url        TEXT,
  ADD COLUMN IF NOT EXISTS monitoring_entities    INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS monitoring_amount      NUMERIC DEFAULT 0;

-- Backfill California Statewide CDC's known contract address (MSA 4/21/2026).
UPDATE public.clients
SET address_line1      = '426 D Street',
    address_city       = 'Davis',
    address_state      = 'CA',
    address_postal_code= '95616',
    address_country    = 'US'
WHERE id = '3256293c-6c98-42bc-a828-2b73a603048e'
  AND (address_line1 IS NULL OR address_line1 = '');

-- Index for quick reverse-lookup from Mercury webhook events to our invoice
-- rows (for when we wire up payment-received webhook reconciliation).
CREATE INDEX IF NOT EXISTS idx_invoices_mercury_invoice_id
  ON public.invoices(mercury_invoice_id)
  WHERE mercury_invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clients_mercury_customer_id
  ON public.clients(mercury_customer_id)
  WHERE mercury_customer_id IS NOT NULL;
