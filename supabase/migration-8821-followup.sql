-- 8821 processor follow-up tracking
--
-- The new /api/cron/8821-processor-followup cron emails the requesting
-- processor when an 8821 has been pending the taxpayer's signature for
-- ≥ 3 days. We need a per-entity timestamp to enforce a 3-day cooldown
-- so processors aren't spammed daily about the same stuck signature.
--
-- Column is nullable; null means "never followed up" → eligible to send.
-- After each send, the cron stamps it with the send time.
--
-- Idempotent.

ALTER TABLE public.request_entities
  ADD COLUMN IF NOT EXISTS followup_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN public.request_entities.followup_sent_at IS
  'Last time the requesting processor was emailed about this entity''s pending 8821 signature. NULL = never followed up. Used by /api/cron/8821-processor-followup to enforce a 3-day cooldown between reminders.';

-- Partial index supports the cron''s most common query: "entities where
-- 8821 has been pending and either we''ve never followed up OR cooldown
-- has elapsed". Filters NULL signed_8821_url at the index level since
-- that''s the gate for "actually pending".
CREATE INDEX IF NOT EXISTS idx_request_entities_8821_followup_pending
  ON public.request_entities(signature_created_at)
  WHERE status = '8821_sent'
    AND signed_8821_url IS NULL;
