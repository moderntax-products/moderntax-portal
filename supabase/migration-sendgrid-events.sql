-- SendGrid Event Webhook — durable per-recipient engagement log
--
-- The Email Activity API on our SendGrid tier caps results at 25
-- messages per query. That's fine for "what's hot right now" but
-- useless for "which lender clicked our follow-up two weeks ago."
-- This table captures every event SendGrid emits and stores it
-- permanently, so the admin engagement view doesn't depend on
-- SendGrid's retention or tier limits.
--
-- SendGrid event types we care about:
--   processed       — accepted for delivery
--   delivered       — accepted by recipient MTA
--   open            — recipient opened the email (image beacon)
--   click           — recipient clicked a tracked link
--   bounce          — recipient MTA rejected
--   dropped         — SendGrid dropped before send (bad addr, spam, etc.)
--   deferred        — recipient MTA deferred; SendGrid will retry
--   spam_report     — recipient marked as spam
--   unsubscribe     — recipient unsubscribed
--   group_unsubscribe — recipient unsubscribed from a specific list
--   group_resubscribe — opposite
--
-- We log every event verbatim and let queries decide which to count.
-- Schema is intentionally wide to avoid migrations every time SendGrid
-- adds a new event field — the raw payload goes in `payload JSONB`.

CREATE TABLE IF NOT EXISTS public.sendgrid_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Core identifiers
  sg_event_id     TEXT NOT NULL,                  -- SendGrid's stable event id (dedup key)
  sg_message_id   TEXT,                           -- SendGrid's per-message id (multiple events per message)
  email           TEXT NOT NULL,                  -- normalized to lowercase
  event_type      TEXT NOT NULL,                  -- e.g. 'open', 'click', 'delivered'
  -- Timestamps
  event_timestamp TIMESTAMPTZ NOT NULL,           -- when the event happened (from SendGrid)
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- when we received the webhook
  -- Event-specific metadata
  url             TEXT,                           -- for click events
  user_agent      TEXT,                           -- for opens / clicks (distinguish humans vs URL-protection scanners)
  ip              TEXT,                           -- recipient IP at event time
  reason          TEXT,                           -- bounce / dropped reason
  status          TEXT,                           -- SMTP status code (e.g. '5.1.1')
  -- Campaign attribution
  category        TEXT[],                         -- ['may2026','lender_reactivation'] etc.
  subject         TEXT,                           -- email subject when known
  -- Full payload for anything we didn't model
  payload         JSONB NOT NULL
);

COMMENT ON TABLE  public.sendgrid_events IS
  'Append-only log of every SendGrid event webhook delivery. Used by /admin/email-engagement to rank recipients without depending on SendGrid Email Activity API tier caps.';
COMMENT ON COLUMN public.sendgrid_events.sg_event_id IS
  'Stable per-event identifier from SendGrid. Unique index enforces idempotency — replays don''t double-count.';
COMMENT ON COLUMN public.sendgrid_events.category IS
  'Marketing categories attached at send time. Filter queries by category to scope to a campaign.';

-- Idempotency: SendGrid retries on non-2xx and may also replay events;
-- the unique index ensures repeat deliveries collapse to one row.
CREATE UNIQUE INDEX IF NOT EXISTS sendgrid_events_sg_event_id_unique
  ON public.sendgrid_events (sg_event_id);

-- Hot-path queries: "show me recent events for the may2026 category"
-- and "show me everything by recipient." These two indexes cover both.
CREATE INDEX IF NOT EXISTS sendgrid_events_email_event_time
  ON public.sendgrid_events (email, event_timestamp DESC);

CREATE INDEX IF NOT EXISTS sendgrid_events_category_event_time
  ON public.sendgrid_events USING GIN (category);

CREATE INDEX IF NOT EXISTS sendgrid_events_event_type_time
  ON public.sendgrid_events (event_type, event_timestamp DESC);

-- ---------------------------------------------------------------------------
-- Engagement summary view — what the admin page queries
-- ---------------------------------------------------------------------------
-- Pre-aggregated per-recipient counts so the admin page is a single
-- SELECT instead of a heavy GROUP BY at request time. Refresh strategy
-- is "materialized view with manual REFRESH" because click events
-- only arrive on the order of a few-per-minute and a stale view by 60s
-- is fine for sales triage.
CREATE MATERIALIZED VIEW IF NOT EXISTS public.email_engagement_summary AS
WITH per_recipient AS (
  SELECT
    email,
    COUNT(*) FILTER (WHERE event_type = 'open')                          AS opens,
    COUNT(DISTINCT sg_message_id) FILTER (WHERE event_type = 'open')     AS unique_opens,
    COUNT(*) FILTER (WHERE event_type = 'click')                         AS clicks,
    COUNT(DISTINCT sg_message_id) FILTER (WHERE event_type = 'click')    AS unique_clicks,
    COUNT(*) FILTER (WHERE event_type = 'delivered')                     AS delivered,
    COUNT(*) FILTER (WHERE event_type = 'bounce')                        AS bounces,
    COUNT(*) FILTER (WHERE event_type IN ('spam_report','spamreport'))   AS spam_reports,
    COUNT(*) FILTER (WHERE event_type IN ('unsubscribe','group_unsubscribe')) AS unsubscribes,
    MIN(event_timestamp)                                                 AS first_event_at,
    MAX(event_timestamp)                                                 AS last_event_at,
    array_agg(DISTINCT cat) FILTER (WHERE cat IS NOT NULL)               AS categories
  FROM public.sendgrid_events
  LEFT JOIN LATERAL unnest(category) AS cat ON TRUE
  GROUP BY email
)
SELECT
  email,
  opens,
  unique_opens,
  clicks,
  unique_clicks,
  delivered,
  bounces,
  spam_reports,
  unsubscribes,
  -- Score: clicks weigh 3x opens (click = intent, open might be Mimecast scanning).
  (clicks * 3 + opens) AS score,
  first_event_at,
  last_event_at,
  categories
FROM per_recipient;

CREATE UNIQUE INDEX IF NOT EXISTS email_engagement_summary_email_unique
  ON public.email_engagement_summary (email);

CREATE INDEX IF NOT EXISTS email_engagement_summary_score_desc
  ON public.email_engagement_summary (score DESC);

COMMENT ON MATERIALIZED VIEW public.email_engagement_summary IS
  'Per-recipient open/click aggregates for the admin engagement page. Refresh with REFRESH MATERIALIZED VIEW CONCURRENTLY public.email_engagement_summary — runs in a few hundred ms even at 100k events.';

-- ---------------------------------------------------------------------------
-- RPC: refresh the materialized view from the cron
-- ---------------------------------------------------------------------------
-- The Vercel cron route /api/cron/email-engagement-refresh calls this
-- function. SECURITY DEFINER so the service-role doesn't need direct
-- ALTER MATERIALIZED VIEW privileges; the function owner does.
CREATE OR REPLACE FUNCTION public.refresh_email_engagement_summary()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- CONCURRENTLY requires the unique index we created above. Falls
  -- back to a plain REFRESH on the first run before any data has
  -- been inserted (CONCURRENTLY errors on an empty view).
  BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.email_engagement_summary;
  EXCEPTION WHEN OTHERS THEN
    REFRESH MATERIALIZED VIEW public.email_engagement_summary;
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_email_engagement_summary() TO service_role;
