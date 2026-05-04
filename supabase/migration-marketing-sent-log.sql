-- Marketing campaign sent log
--
-- The May 2026 lender outreach (and future campaigns) needs a persistent
-- per-recipient record so the daily cron picks the next 25 unsent leads
-- instead of re-emailing people. The script-based version persisted to
-- scripts/data/may2026-sent.json, but Vercel's serverless filesystem is
-- read-only at runtime — so when the cron took over for the script, we
-- needed a real DB table.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.marketing_sent_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  segment     TEXT NOT NULL,             -- 'lenders' | 'compliance' | future...
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  campaign    TEXT DEFAULT 'may2026'     -- name of the campaign for future analytics
);

-- Lookup by (email, campaign) — the daily cron's main query is "has this
-- recipient been sent yet for the active campaign?"
CREATE INDEX IF NOT EXISTS idx_marketing_sent_log_email_campaign
  ON public.marketing_sent_log(email, campaign);

CREATE INDEX IF NOT EXISTS idx_marketing_sent_log_sent_at
  ON public.marketing_sent_log(sent_at DESC);

-- Backfill from the JSON-based sent log used by the script before the cron
-- took over. Inserts the May 1 + May 4 (today's manual fire) rows so the
-- cron doesn't re-mail those recipients tomorrow morning.
-- (Run manually by Matt — paste from scripts/data/may2026-sent.json or
-- skip if already loaded; the table is idempotent on duplicate inserts
-- only if you add a unique constraint, which we deliberately skip to allow
-- multi-campaign sends to the same email.)
