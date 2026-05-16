-- Email campaign performance + revenue attribution
--
-- Extends the existing sendgrid_events infra (supabase/migration-sendgrid-events.sql)
-- with two new views the admin Campaigns + Conversions tabs query.
--
-- This migration is ADDITIVE — it does not modify the existing
-- email_engagement_summary view or its refresh function.
--
-- Apply via: Supabase Dashboard → SQL Editor → paste + Run.

-- ---------------------------------------------------------------------------
-- 1. email_campaign_summary — per-category funnel
-- ---------------------------------------------------------------------------
-- One row per category (a category = a campaign / email template).
-- Shows the full funnel: messages sent → delivered → opened → clicked,
-- plus the negative signals (bounce, spam, unsubscribe). Click and open
-- rates are computed as fractions of unique recipients so the ratios
-- aren't inflated by repeat triggers.
--
-- Materialized for the same reason the per-recipient view is: keeps the
-- admin page render cheap and the underlying GROUP BY out of the request
-- path. Refresh on the same cadence (every 5 min via cron + on-view).
CREATE MATERIALIZED VIEW IF NOT EXISTS public.email_campaign_summary AS
WITH per_category AS (
  SELECT
    cat AS category,
    COUNT(DISTINCT sg_message_id) FILTER (WHERE event_type = 'processed') AS sent,
    COUNT(DISTINCT sg_message_id) FILTER (WHERE event_type = 'delivered') AS delivered,
    COUNT(DISTINCT email) FILTER (WHERE event_type = 'open')              AS unique_opens,
    COUNT(*) FILTER (WHERE event_type = 'open')                           AS opens,
    COUNT(DISTINCT email) FILTER (WHERE event_type = 'click')             AS unique_clicks,
    COUNT(*) FILTER (WHERE event_type = 'click')                          AS clicks,
    COUNT(DISTINCT sg_message_id) FILTER (WHERE event_type = 'bounce')    AS bounces,
    COUNT(DISTINCT email) FILTER (WHERE event_type IN ('spam_report','spamreport')) AS spam_reports,
    COUNT(DISTINCT email) FILTER (WHERE event_type IN ('unsubscribe','group_unsubscribe')) AS unsubscribes,
    MIN(event_timestamp)                                                  AS first_event_at,
    MAX(event_timestamp)                                                  AS last_event_at
  FROM public.sendgrid_events
  LEFT JOIN LATERAL unnest(category) AS cat ON TRUE
  WHERE cat IS NOT NULL
  GROUP BY cat
)
SELECT
  category,
  sent,
  delivered,
  unique_opens,
  opens,
  unique_clicks,
  clicks,
  bounces,
  spam_reports,
  unsubscribes,
  CASE WHEN sent > 0 THEN ROUND(100.0 * delivered      / sent, 1)     END AS delivery_rate,
  CASE WHEN delivered > 0 THEN ROUND(100.0 * unique_opens / delivered, 1) END AS open_rate,
  CASE WHEN unique_opens > 0 THEN ROUND(100.0 * unique_clicks / unique_opens, 1) END AS click_through_rate,
  CASE WHEN delivered > 0 THEN ROUND(100.0 * unique_clicks / delivered, 1) END AS click_rate,
  first_event_at,
  last_event_at
FROM per_category;

CREATE UNIQUE INDEX IF NOT EXISTS email_campaign_summary_category_unique
  ON public.email_campaign_summary (category);

CREATE INDEX IF NOT EXISTS email_campaign_summary_last_event_desc
  ON public.email_campaign_summary (last_event_at DESC);

COMMENT ON MATERIALIZED VIEW public.email_campaign_summary IS
  'Per-category email funnel + computed rates. Drives the Campaigns tab on /admin/email-engagement.';

-- ---------------------------------------------------------------------------
-- 2. email_attributed_conversions — clicks → outcomes within attribution window
-- ---------------------------------------------------------------------------
-- For each conversion event (new request submitted, 8821 signed, invoice paid),
-- find the most recent prior click/open by that recipient and attribute the
-- conversion to that email's category. Attribution window: 30 days.
--
-- This is NOT materialized — conversions are low-volume and the query is
-- cheap enough at request time. Admin page filters by date range and
-- groups by category for the Conversions tab.
CREATE OR REPLACE VIEW public.email_attributed_conversions AS
WITH
-- All recent click events (the highest-intent signal) with their category
clicks AS (
  SELECT
    LOWER(email) AS email,
    event_timestamp AS clicked_at,
    cat AS category,
    subject,
    sg_message_id
  FROM public.sendgrid_events
  LEFT JOIN LATERAL unnest(category) AS cat ON TRUE
  WHERE event_type = 'click'
    AND event_timestamp > NOW() - INTERVAL '90 days'
    AND cat IS NOT NULL
),
-- Conversion event 1: new request submitted by an authenticated user.
-- The submitter is `requests.requested_by` (FK → profiles.id); join to
-- profiles to get the email.
request_conversions AS (
  SELECT
    LOWER(p.email)              AS email,
    r.created_at                AS converted_at,
    'request_submitted'::TEXT   AS conversion_type,
    r.id::TEXT                  AS conversion_ref,
    r.loan_number               AS conversion_label,
    NULL::NUMERIC               AS conversion_value
  FROM public.requests r
  JOIN public.profiles p ON p.id = r.requested_by
  WHERE r.created_at > NOW() - INTERVAL '90 days'
),
-- Conversion event 2: 8821 signed by borrower. We attribute the signature
-- to whatever email the SIGNER (not the submitter) most recently engaged
-- with — typically the 8821 send itself.
signed_8821_conversions AS (
  SELECT
    LOWER(e.signer_email)        AS email,
    COALESCE(e.signature_created_at, e.updated_at) AS converted_at,
    '8821_signed'::TEXT          AS conversion_type,
    e.id::TEXT                   AS conversion_ref,
    e.entity_name                AS conversion_label,
    NULL::NUMERIC                AS conversion_value
  FROM public.request_entities e
  WHERE e.signer_email IS NOT NULL
    AND e.signed_8821_url IS NOT NULL
    AND COALESCE(e.signature_created_at, e.updated_at) > NOW() - INTERVAL '90 days'
),
-- Conversion event 3: invoice paid. Email comes via the client's
-- billing AP email. (The clients table doesn't have a separate
-- "contact_email" — billing_ap_email IS the contact for invoicing.)
-- Conversions for clients without billing_ap_email get dropped — they
-- can be backfilled by either filling in the email or adding a manual
-- attribution table down the road.
invoice_conversions AS (
  SELECT
    LOWER(c.billing_ap_email) AS email,
    i.paid_at                 AS converted_at,
    'invoice_paid'::TEXT      AS conversion_type,
    i.id::TEXT                AS conversion_ref,
    i.invoice_number          AS conversion_label,
    i.total_amount            AS conversion_value
  FROM public.invoices i
  JOIN public.clients c ON c.id = i.client_id
  WHERE i.status = 'paid'
    AND i.paid_at IS NOT NULL
    AND i.paid_at > NOW() - INTERVAL '90 days'
    AND c.billing_ap_email IS NOT NULL
),
all_conversions AS (
  SELECT * FROM request_conversions
  UNION ALL
  SELECT * FROM signed_8821_conversions
  UNION ALL
  SELECT * FROM invoice_conversions
)
SELECT
  ac.email,
  ac.converted_at,
  ac.conversion_type,
  ac.conversion_ref,
  ac.conversion_label,
  ac.conversion_value,
  -- LATERAL join finds the most-recent prior click by this recipient
  -- within the 30-day attribution window. NULL category = direct/unattributed.
  attr.category   AS attributed_category,
  attr.subject    AS attributed_subject,
  attr.clicked_at AS attributed_clicked_at,
  (ac.converted_at - attr.clicked_at) AS days_to_convert
FROM all_conversions ac
LEFT JOIN LATERAL (
  SELECT category, subject, clicked_at
  FROM clicks c
  WHERE c.email = ac.email
    AND c.clicked_at <= ac.converted_at
    AND c.clicked_at > ac.converted_at - INTERVAL '30 days'
  ORDER BY c.clicked_at DESC
  LIMIT 1
) attr ON TRUE;

COMMENT ON VIEW public.email_attributed_conversions IS
  'Conversions (new request, 8821 signed, invoice paid) attributed to the most-recent click within a 30-day window. NULL attributed_category = direct/unattributed.';

-- ---------------------------------------------------------------------------
-- 3. Refresh function extension — also refresh the campaign view
-- ---------------------------------------------------------------------------
-- Replaces the original refresh_email_engagement_summary() with a version
-- that refreshes BOTH materialized views in one call. The cron at
-- /api/cron/email-engagement-refresh continues calling the same function name.
CREATE OR REPLACE FUNCTION public.refresh_email_engagement_summary()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.email_engagement_summary;
  EXCEPTION WHEN OTHERS THEN
    REFRESH MATERIALIZED VIEW public.email_engagement_summary;
  END;
  BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.email_campaign_summary;
  EXCEPTION WHEN OTHERS THEN
    REFRESH MATERIALIZED VIEW public.email_campaign_summary;
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_email_engagement_summary() TO service_role;
