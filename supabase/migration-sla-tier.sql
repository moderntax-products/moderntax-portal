-- Premium SLA tier — gates the same-day-target turnaround commitment.
-- Live as a real product 2026-05-28: Cal Statewide CDC is the first
-- production account on Premium; trial accounts get a CTA on their
-- dashboard to upgrade.
--
-- Driver: Enterprise Bank discovery call ("yeah same day turnaround so
-- I would imagine there's a cost difference between same day turnaround
-- time next day") + Cal Statewide already paying $79.98/entity which
-- implicitly funded the premium tier.
--
-- Mechanism:
--   - clients.sla_tier in {'standard', 'premium'}
--   - 'premium' triggers:
--     • Same-day turnaround target (vs. 24-48h standard)
--     • Expert-routing priority (assignment queue picks premium first)
--     • Premium SLA badge on processor / manager dashboard surfaces
--     • Banner on request detail page
--   - clients.sla_tier_upgraded_at records when upgrade fired (for
--     billing prorations, audit, and any retroactive SLA promises)

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS sla_tier TEXT NOT NULL DEFAULT 'standard'
    CHECK (sla_tier IN ('standard', 'premium'));

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS sla_tier_upgraded_at TIMESTAMPTZ;

-- Activate Cal Statewide on premium immediately. They've been paying the
-- $79.98 enterprise verification rate and the implicit same-day SLA was
-- the unstated value-add behind that price.
UPDATE public.clients
   SET sla_tier = 'premium',
       sla_tier_upgraded_at = COALESCE(sla_tier_upgraded_at, NOW())
 WHERE name ILIKE 'Cal%Statewide%';

COMMENT ON COLUMN public.clients.sla_tier IS
  'standard = 24-48h turnaround target. premium = same-day target + expert-routing priority + premium SLA badge on customer surfaces. Set via /api/billing/upgrade-sla-tier or directly in Studio.';
