-- Stripe payment-method-on-file columns on `clients`.
--
-- After the 3 free trial pulls, every client must have a saved payment method
-- (card or ACH) before they can place new orders, buy add-ons, or upgrade
-- tiers. The saved Stripe payment method is auto-charged when monthly
-- invoices issue, when add-ons are purchased, and when entities complete
-- under PAYG/Deposit billing.
--
-- New columns:
--   stripe_customer_id           — Stripe Customer ID (cus_xxx). Created on
--                                   first SetupIntent flow and reused thereafter.
--   stripe_payment_method_id     — default Payment Method ID (pm_xxx) attached
--                                   to the customer. Used as off_session source
--                                   for auto-charges.
--   payment_method_type          — 'card' | 'us_bank_account' (ACH)
--   payment_method_brand         — 'visa', 'mastercard', 'amex', etc. (cards
--                                   only) or the bank short-name (ACH).
--   payment_method_last4         — Last 4 of card or bank account.
--   payment_method_attached_at   — When the method was first attached. Used
--                                   for the "method on file since X" UI line.
--   payment_method_status        — 'active' | 'expired' | 'detached'. We mark
--                                   detached on payment_method.detached webhook
--                                   so the order gate re-fires.
--
-- Idempotent.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS stripe_customer_id           TEXT,
  ADD COLUMN IF NOT EXISTS stripe_payment_method_id     TEXT,
  ADD COLUMN IF NOT EXISTS payment_method_type          TEXT,
  ADD COLUMN IF NOT EXISTS payment_method_brand         TEXT,
  ADD COLUMN IF NOT EXISTS payment_method_last4         TEXT,
  ADD COLUMN IF NOT EXISTS payment_method_attached_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_method_status        TEXT DEFAULT 'active';

-- Index for the order-gate's "does this client have an active payment method?"
-- query. Partial — only clients with a saved method get indexed.
CREATE INDEX IF NOT EXISTS idx_clients_stripe_payment_method
  ON public.clients(id)
  WHERE stripe_payment_method_id IS NOT NULL
    AND payment_method_status = 'active';

COMMENT ON COLUMN public.clients.stripe_customer_id IS
  'Stripe Customer ID (cus_xxx). Source of truth for billing payment_method, address, default_payment_method.';
COMMENT ON COLUMN public.clients.stripe_payment_method_id IS
  'Default Stripe PaymentMethod ID (pm_xxx). Auto-charged on monthly invoice + add-on purchases + tier upgrades.';
COMMENT ON COLUMN public.clients.payment_method_status IS
  'active | expired | detached. Set by Stripe webhook (payment_method.detached). active means orders can be placed.';

-- ---------------------------------------------------------------------------
-- Stripe charge tracking on `invoices`.
--
-- When the auto-invoice cron creates an invoice for a client with a saved
-- payment method, we create a Stripe PaymentIntent off_session and charge it.
-- These columns hold the result so we know the invoice was paid via Stripe
-- (vs. paid via Mercury). Belt-and-suspenders against double-payment.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_charge_id         TEXT,
  ADD COLUMN IF NOT EXISTS paid_via                 TEXT,  -- 'stripe' | 'mercury' | 'manual'
  ADD COLUMN IF NOT EXISTS paid_at                  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_invoices_stripe_payment_intent
  ON public.invoices(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Verification:
--
-- SELECT id, name, stripe_customer_id, stripe_payment_method_id,
--        payment_method_type, payment_method_brand, payment_method_last4,
--        payment_method_status, payment_method_attached_at
-- FROM public.clients
-- ORDER BY name;
