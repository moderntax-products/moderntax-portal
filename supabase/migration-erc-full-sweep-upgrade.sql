-- ERC Full-Sweep Premium upgrade — added May 2026 for TaxTaker POC
--
-- Partners ordering 941 transcripts pay $79.98 base per entity (covers up
-- to 3 ERC-eligible quarters). The +$79.98 premium upgrade pulls ALL
-- eligible quarters (2020 Q2–Q4 + 2021 Q1–Q3, plus Q4 2021 for RSBs).
--
-- This migration adds the columns we need to track the premium upgrade as
-- a one-time Stripe purchase keyed to the entity:
--   erc_full_sweep_paid          — gate flag the expert checks before pulling
--   erc_full_sweep_paid_at       — when payment confirmed by Stripe webhook
--   erc_full_sweep_session_id    — checkout session id (for support lookups)
--   erc_full_sweep_payment_intent_id  — for refund tracing if needed
--
-- All optional / nullable — existing rows are unaffected. Idempotent.

ALTER TABLE public.request_entities
  ADD COLUMN IF NOT EXISTS erc_full_sweep_paid       BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS erc_full_sweep_paid_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS erc_full_sweep_session_id        TEXT,
  ADD COLUMN IF NOT EXISTS erc_full_sweep_payment_intent_id TEXT;

COMMENT ON COLUMN public.request_entities.erc_full_sweep_paid IS
  'TRUE if the partner paid the ERC Full-Sweep Premium upgrade ($79.98) via Stripe. Expert pulls all 6–7 eligible ERC quarters when this is set. NULL/FALSE = base tier (up to 3 quarters).';

-- Lookup by Stripe session id when the webhook lands
CREATE INDEX IF NOT EXISTS request_entities_erc_full_sweep_session_idx
  ON public.request_entities (erc_full_sweep_session_id)
  WHERE erc_full_sweep_session_id IS NOT NULL;
