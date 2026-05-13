-- ===========================================================================
-- TWO PRODUCTION MIGRATIONS — paste this entire file into Supabase Studio
-- (SQL Editor) on the production project and click Run.
--
-- Both are idempotent (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS) so safe to re-run.
--
-- WHY THIS IS NEEDED
--   1. /admin/erc-report/[entityId] is currently 404'ing because the page
--      query references erc_full_sweep_paid which doesn't exist in prod yet.
--      Fix: migration #1 below.
--   2. The Request Check Reissue button can't write rows because the
--      check_reissue_requests table doesn't exist in prod yet.
--      Fix: migration #2 below.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- #1: ERC Full-Sweep upgrade columns on request_entities
-- ---------------------------------------------------------------------------
ALTER TABLE public.request_entities
  ADD COLUMN IF NOT EXISTS erc_full_sweep_paid       BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS erc_full_sweep_paid_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS erc_full_sweep_session_id        TEXT,
  ADD COLUMN IF NOT EXISTS erc_full_sweep_payment_intent_id TEXT;

COMMENT ON COLUMN public.request_entities.erc_full_sweep_paid IS
  'TRUE if the partner paid the ERC Full-Sweep Premium upgrade ($79.98) via Stripe. Expert pulls all 6–7 eligible ERC quarters when this is set. NULL/FALSE = base tier (up to 3 quarters).';

CREATE INDEX IF NOT EXISTS request_entities_erc_full_sweep_session_idx
  ON public.request_entities (erc_full_sweep_session_id)
  WHERE erc_full_sweep_session_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- #2: check_reissue_requests table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.check_reissue_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       UUID NOT NULL REFERENCES public.request_entities(id) ON DELETE CASCADE,
  request_id      UUID NOT NULL REFERENCES public.requests(id) ON DELETE CASCADE,
  client_id       UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  tax_year        INT  NOT NULL,
  tax_quarter     INT  NOT NULL CHECK (tax_quarter BETWEEN 1 AND 4),
  original_refund_amount     NUMERIC(12,2),
  original_refund_date       DATE,
  returned_undelivered_date  DATE,
  status          TEXT NOT NULL DEFAULT 'requested',
  new_address_line1   TEXT,
  new_address_line2   TEXT,
  new_address_city    TEXT,
  new_address_state   TEXT,
  new_address_zip     TEXT,
  payment_status  TEXT NOT NULL DEFAULT 'unpaid',
  service_fee     NUMERIC(10,2) NOT NULL DEFAULT 1000.00,
  stripe_session_id        TEXT,
  stripe_payment_intent_id TEXT,
  paid_at         TIMESTAMPTZ,
  billed_at       TIMESTAMPTZ,
  invoice_id      UUID REFERENCES public.invoices(id),
  requested_by    UUID REFERENCES auth.users(id),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_to     UUID REFERENCES auth.users(id),
  call_session_id UUID,
  completed_at    TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.check_reissue_requests IS
  'Premium service tracking — one row per IRS refund check we are recovering on a client''s behalf. Billed at $1000/check (PRICE_CHECK_REISSUE in lib/pricing.ts) via Mercury ACH, or $999.99 via Stripe Checkout.';

CREATE INDEX IF NOT EXISTS check_reissue_requests_status_idx
  ON public.check_reissue_requests (status, requested_at DESC);
CREATE INDEX IF NOT EXISTS check_reissue_requests_entity_idx
  ON public.check_reissue_requests (entity_id, tax_year, tax_quarter);
CREATE INDEX IF NOT EXISTS check_reissue_requests_client_idx
  ON public.check_reissue_requests (client_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS check_reissue_requests_entity_quarter_active_unique
  ON public.check_reissue_requests (entity_id, tax_year, tax_quarter)
  WHERE status NOT IN ('cancelled', 'failed');

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
