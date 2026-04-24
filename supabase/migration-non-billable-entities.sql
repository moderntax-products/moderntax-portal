-- Non-billable flag for entities completed via backfill / migration / comp.
--
-- Use case: the Centerstone Dropbox migration imported transcripts that already
-- existed in their Dropbox; ModernTax never did the IRS pull, so those entities
-- should be marked completed (so they leave the work queue) but MUST NOT appear
-- on the next monthly invoice.
--
-- Going forward, any entity completed for which we should not bill the client
-- (migrations, comped work, dispute credits, processor-error replays) gets
-- non_billable=true with a non_billable_reason audit trail.

ALTER TABLE request_entities
  ADD COLUMN IF NOT EXISTS non_billable BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS non_billable_reason TEXT;

COMMENT ON COLUMN request_entities.non_billable IS
  'When true, this completed entity is excluded from billing/invoice generation. Used for migrations, comped work, and dispute credits.';
COMMENT ON COLUMN request_entities.non_billable_reason IS
  'Free-text audit trail explaining why this entity was marked non-billable.';

-- Partial index keyed for the invoice generator's hot path:
-- "find billable, completed entities in a billing period."
CREATE INDEX IF NOT EXISTS idx_request_entities_billable_completed
  ON request_entities (status, completed_at)
  WHERE non_billable = false AND status = 'completed';
