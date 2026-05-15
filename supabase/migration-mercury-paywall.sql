-- Migration: Mercury payment-method paywall on new requests
--
-- Driver: TaxTaker (Ari Salafia) is moving forward with multiple new
-- requests starting tomorrow. We're avoiding Stripe until the existing
-- Stripe processing balance clears, so all new clients must have a
-- Mercury account on file before they can submit requests.
--
-- Three trusted clients get an explicit bypass for ops-continuity reasons:
--   · Centerstone SBA Lending — payments set up
--   · California Statewide CDC — payments set up
--   · Clearfirm — temporary bypass while their billing is consolidated
--
-- All other clients (TaxTaker included) must have a non-NULL
-- `mercury_customer_id` before any new request is created. Existing
-- in-flight requests are unaffected.
--
-- Implementation:
--   - New boolean column `bypass_payment_paywall` (default FALSE).
--   - Set TRUE for the three trusted clients above.
--   - Application code at every request-creation entrypoint
--     (CSV / PDF / API intake / manual entity form) checks:
--         clients.bypass_payment_paywall = TRUE
--             OR clients.mercury_customer_id IS NOT NULL
--     If neither is true, return 402 with a paywall message.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS bypass_payment_paywall BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.clients.bypass_payment_paywall IS
  'When TRUE, this client can submit new requests without having a Mercury payment method on file. Used as a temporary bypass for trusted clients while Mercury onboarding is being completed.';

-- Set bypass for the three trusted clients
UPDATE public.clients
   SET bypass_payment_paywall = TRUE
 WHERE slug IN ('centerstone', 'centerstone-sba-lending', 'california-statewide-cdc', 'cal-statewide', 'clearfirm');

-- Verify (output: should show the affected rows)
-- SELECT name, slug, bypass_payment_paywall, mercury_customer_id IS NOT NULL AS has_mercury
--   FROM public.clients
--  ORDER BY bypass_payment_paywall DESC, name;
