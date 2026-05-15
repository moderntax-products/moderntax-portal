-- Migration: per-client trial entity allowance
--
-- Replaces the global TRIAL_FREE_ENTITIES = 3 hardcoded constant in
-- lib/order-gate.ts with a per-client cap. Lets specific clients receive
-- different trial allowances negotiated case-by-case (e.g., a 1-entity
-- evaluation, a 3-entity proof-of-concept, etc.) without code changes.
--
-- 2026-05-14 driver: Matt set per-client trial caps for the three clients
-- ramping into Mercury onboarding:
--   · Banc of California — 1 more trial entity (2 total: 1 used + 1 more)
--   · Enterprise Financial Services Corp — 3 trial entities (0 used + 3)
--   · Growth Corp — 2 trial entities (0 used + 2 — Katie Lent / Troch-Mc Neil)
--
-- All other free_trial=true clients default to 0 (no trial allowance under
-- the new policy — they must enroll Mercury via /invoicing). The migration
-- preserves the existing 3-entity behavior only for the three clients
-- explicitly granted trial allowances; everyone else who was relying on
-- the old global constant is now subject to the Mercury paywall.
--
-- Gate logic (lib/order-gate.ts):
--   completed_count < trial_entities_allowed  →  allowed
-- The compare-to-lifetime-completed approach means we don't need a
-- decrementer — once the cap is set, every completed entity counts
-- against it automatically.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS trial_entities_allowed INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.clients.trial_entities_allowed IS
  'Cap on trial entities (compared to lifetime completed entity count at gate-check time). 0 = no trial allowance, must enroll Mercury or have bypass to submit. Set per-client based on negotiated trial scope.';

-- Apply Matt 2026-05-14 trial allowances. Values are computed as
-- current_completed_count + N_more_allowed:
--   Banc of California (1 completed + 1 more) = 2
--   Enterprise Financial (0 + 3) = 3
--   Growth Corp (0 + 2) = 2
UPDATE public.clients SET trial_entities_allowed = 2 WHERE slug = 'banc-of-california';
UPDATE public.clients SET trial_entities_allowed = 3 WHERE slug = 'enterprise-financial-services-corp';
UPDATE public.clients SET trial_entities_allowed = 2 WHERE slug = 'growth-corp';

-- Verify (run after the UPDATEs):
-- SELECT name, slug, trial_entities_allowed, mercury_customer_id IS NOT NULL AS has_mercury, bypass_payment_paywall
--   FROM public.clients
--  WHERE trial_entities_allowed > 0 OR mercury_customer_id IS NOT NULL OR bypass_payment_paywall
--  ORDER BY name;
