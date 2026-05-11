-- Check Reissue Service — added May 2026 for the TaxTaker POC
--
-- When an ERC analysis finds a 941 quarter with TC 846 + TC 740
-- (refund issued + check returned undelivered), the client has IRS
-- money trapped at the agency. ModernTax offers a premium service to
-- recover it: file Form 8822-B (address update), call the IRS
-- Business & Specialty Tax line, request reissue, track to delivery.
--
-- This table tracks each reissue request as a billable line item.
-- Pricing constants live in lib/pricing.ts (PRICE_CHECK_REISSUE = $1000).
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.check_reissue_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What we're recovering
  entity_id       UUID NOT NULL REFERENCES public.request_entities(id) ON DELETE CASCADE,
  request_id      UUID NOT NULL REFERENCES public.requests(id) ON DELETE CASCADE,
  client_id       UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  -- ERC-quarter context. tax_year and tax_quarter let us tie back to the
  -- specific 941 transcript that surfaced the returned-undelivered check.
  tax_year        INT  NOT NULL,
  tax_quarter     INT  NOT NULL CHECK (tax_quarter BETWEEN 1 AND 4),
  -- Original refund context — what we're trying to recover
  original_refund_amount     NUMERIC(12,2),  -- the $ TC 846 originally issued
  original_refund_date       DATE,           -- when the IRS first cut the check
  returned_undelivered_date  DATE,           -- when TC 740 posted
  -- Service progression
  status          TEXT NOT NULL DEFAULT 'requested',
    -- requested:    customer asked for the service
    -- 8822b_filed:  Form 8822-B filed with IRS (address update)
    -- irs_called:   our practitioner called the reissuance line
    -- reissued:     IRS confirmed reissue
    -- delivered:    customer reports receipt
    -- failed:       could not be recovered (notes column required)
    -- cancelled:    customer pulled the request
  -- Address update we're submitting on behalf of the taxpayer
  new_address_line1   TEXT,
  new_address_line2   TEXT,
  new_address_city    TEXT,
  new_address_state   TEXT,
  new_address_zip     TEXT,
  -- Billing — Stripe-gated. The $1,000 fee must be collected up-front
  -- before the work starts. payment_status flows:
  --   unpaid  → checkout_pending (Stripe session created, awaiting payment)
  --           → paid             (webhook confirmed checkout.session.completed)
  --           → refunded         (admin refunded the customer; service halts)
  payment_status  TEXT NOT NULL DEFAULT 'unpaid',
  service_fee     NUMERIC(10,2) NOT NULL DEFAULT 1000.00,
  stripe_session_id        TEXT,
  stripe_payment_intent_id TEXT,
  paid_at         TIMESTAMPTZ,
  billed_at       TIMESTAMPTZ,
  invoice_id      UUID REFERENCES public.invoices(id),
  -- Workflow trail
  requested_by    UUID REFERENCES auth.users(id),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_to     UUID REFERENCES auth.users(id),    -- expert who will make the call
  call_session_id UUID,                              -- ref to irs_call_sessions when call fires
  completed_at    TIMESTAMPTZ,
  notes           TEXT,                              -- internal notes + failure reasons
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.check_reissue_requests IS
  'Premium service tracking — one row per IRS refund check we are recovering on a client''s behalf. Created when admin clicks "Request Check Reissue" on the /admin/erc-report page for a quarter that surfaced TC 846 + TC 740. Billed at $1000/check (PRICE_CHECK_REISSUE in lib/pricing.ts).';

COMMENT ON COLUMN public.check_reissue_requests.status IS
  'Lifecycle: requested → 8822b_filed → irs_called → reissued → delivered. Terminal: delivered, failed, cancelled.';

-- Indexes for the admin queue + per-entity history
CREATE INDEX IF NOT EXISTS check_reissue_requests_status_idx
  ON public.check_reissue_requests (status, requested_at DESC);

CREATE INDEX IF NOT EXISTS check_reissue_requests_entity_idx
  ON public.check_reissue_requests (entity_id, tax_year, tax_quarter);

CREATE INDEX IF NOT EXISTS check_reissue_requests_client_idx
  ON public.check_reissue_requests (client_id, status);

-- Unique per (entity, quarter) so we don't double-request the same check.
-- Partial index excludes cancelled/failed so a re-request after a failed
-- attempt isn't blocked.
CREATE UNIQUE INDEX IF NOT EXISTS check_reissue_requests_entity_quarter_active_unique
  ON public.check_reissue_requests (entity_id, tax_year, tax_quarter)
  WHERE status NOT IN ('cancelled', 'failed');

-- Trigger to keep updated_at fresh
CREATE OR REPLACE FUNCTION public.check_reissue_requests_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS check_reissue_requests_touch_updated_at_trg ON public.check_reissue_requests;
CREATE TRIGGER check_reissue_requests_touch_updated_at_trg
  BEFORE UPDATE ON public.check_reissue_requests
  FOR EACH ROW EXECUTE FUNCTION public.check_reissue_requests_touch_updated_at();

-- RLS — service-role only by default (writes from admin UI + API routes).
-- Clients can see their own reissue requests via the standard admin
-- portal flow (admin user with client_id = the row's client_id).
ALTER TABLE public.check_reissue_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS check_reissue_requests_admin_select ON public.check_reissue_requests;
CREATE POLICY check_reissue_requests_admin_select ON public.check_reissue_requests
  FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.role IN ('admin', 'manager', 'processor', 'expert', 'team_member')
    )
  );
