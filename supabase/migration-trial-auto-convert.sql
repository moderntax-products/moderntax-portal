-- Trial Auto-Convert Schema — June 2026
-- Adds columns that power card-before-pull + 7-day auto-convert + pilot block.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS trial_started_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_expires_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_card_captured_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_converted_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_pulls_used         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trial_pilot_offered_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_pilot_purchased_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pilot_pulls_remaining    INTEGER;

COMMENT ON COLUMN public.clients.trial_started_at IS 'Set when admin approves trial.';
COMMENT ON COLUMN public.clients.trial_expires_at IS 'trial_started_at + 7 days.';
COMMENT ON COLUMN public.clients.trial_card_captured_at IS 'Set when Stripe card is saved. REQUIRED before any pull is allowed.';
COMMENT ON COLUMN public.clients.trial_converted_at IS 'Set on first auto-charge at trial exhaustion.';
COMMENT ON COLUMN public.clients.trial_pulls_used IS 'Counter incremented at entity completion. Display only.';
COMMENT ON COLUMN public.clients.pilot_pulls_remaining IS 'Remaining pre-paid pulls in a purchased pilot block.';

ALTER TABLE public.clients
  ALTER COLUMN trial_entities_allowed SET DEFAULT 1;

-- Backfill trial_converted_at for existing Stripe-card clients
UPDATE public.clients
  SET trial_converted_at = payment_method_attached_at
WHERE stripe_payment_method_id IS NOT NULL
  AND payment_method_status = 'active'
  AND trial_converted_at IS NULL
  AND bypass_payment_paywall = false
  AND mercury_customer_id IS NULL;
