-- Subscription billing model support
-- Some clients (Clearfirm, future resellers) are on a monthly subscription
-- with an entity cap + overage rate, rather than per-TIN pricing.
--
-- Runs once. Safe to re-run (IF NOT EXISTS guards).

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS billing_model TEXT DEFAULT 'per_tin',
  ADD COLUMN IF NOT EXISTS subscription_monthly_amount    NUMERIC,
  ADD COLUMN IF NOT EXISTS subscription_included_entities INT,
  ADD COLUMN IF NOT EXISTS subscription_overage_rate      NUMERIC,
  ADD COLUMN IF NOT EXISTS billing_effective_from         DATE,
  ADD COLUMN IF NOT EXISTS billing_notes                  TEXT;

-- Enforce model values (per_tin = rate-per-TIN; subscription = flat + overage).
DO $$ BEGIN
  ALTER TABLE public.clients
    ADD CONSTRAINT clients_billing_model_check
    CHECK (billing_model IN ('per_tin', 'subscription'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Default everyone to per_tin (matches current behaviour).
UPDATE public.clients SET billing_model = 'per_tin' WHERE billing_model IS NULL;

-- Clearfirm: $2,499/month, 167 entities included, $20 per overage.
UPDATE public.clients
SET billing_model                  = 'subscription',
    subscription_monthly_amount    = 2499.00,
    subscription_included_entities = 167,
    subscription_overage_rate      = 20.00
WHERE id = '09d29d80-eccc-4865-9e9b-97e1cd396464';

-- Cal Statewide CDC: PAYG per-TIN at $79.98. MSA effective 2026-04-21, so
-- the first (prorated) invoice on 2026-05-01 bills only for April 21-30
-- usage. billing_effective_from prevents any pre-signature transcripts
-- from accidentally being invoiced.
UPDATE public.clients
SET billing_effective_from = '2026-04-21'
WHERE id = '3256293c-6c98-42bc-a828-2b73a603048e';

-- TMC Financing: awaiting MSA signature. The $2,500 Mercury invoice (INV-16)
-- is NOT ordinary AR — it will convert to upfront credit applied against the
-- first $2,500 of PAYG usage once they countersign. Flag with billing_notes
-- so the dashboard buckets their invoice as "pending signature", not overdue.
UPDATE public.clients
SET billing_notes = 'Awaiting MSA signature. $2,500 Mercury invoice (INV-16) is pending as upfront credit toward first PAYG usage at $79.98/TIN once signed.'
WHERE id = '58b4a824-2912-4588-a48d-1ca7ead39a5e';
