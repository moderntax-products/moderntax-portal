-- Diagnostic: split the compliance drip funnel by audience cohort so we
-- can tell whether the 0%-open dashboard is an audience problem (sending
-- to lender processors) or a deliverability problem (real borrowers
-- aren't opening either). Run after pasting in Supabase Studio.
--
-- Driver: 2026-05-28 Matt — compliance dashboard showed 0 opens, 2
-- unsubs, 2 page visits across 61 sends. The audience filter shipped
-- with c0c92b9+ (lib/compliance-drip.ts isBorrowerEmail) but the
-- existing 60 enrollments stay running per Matt's directive. This SQL
-- gives the breakdown we need to decide whether to revisit that choice.

-- ====================================================================
-- 1. Cohort breakdown of every drip row
-- ====================================================================
-- Splits enrollments into:
--   borrower_clean     — signer_email is a personal domain, no profile match
--   lender_processor   — signer_email matches a portal processor/manager
--   moderntax_internal — signer_email matches an admin/expert profile
--   client_domain      — signer_email on a denylisted lender domain but no profile (e.g. unprovisioned employee)
--
-- For each cohort: enrollment count, send count, open count, click count,
-- unsub count. Look for a cohort with non-zero opens — that's the one
-- actually working.

WITH cohort AS (
  SELECT d.id,
         d.signer_email,
         d.entity_name,
         d.drip_stage,
         d.last_email_sent_at,
         d.last_opened_at,
         d.last_clicked_at,
         d.unsubscribed,
         d.consultation_booked,
         CASE
           WHEN p.role IN ('admin', 'expert') THEN 'moderntax_internal'
           WHEN p.role IN ('processor', 'manager') THEN 'lender_processor'
           WHEN split_part(lower(d.signer_email), '@', 2) IN
                ('teamcenterstone.com', 'statewidecdc.com', 'moderntax.io', 'moderntax.com')
             THEN 'client_domain_no_profile'
           ELSE 'borrower_clean'
         END AS cohort_label
    FROM public.compliance_drip d
    LEFT JOIN public.profiles p
      ON lower(p.email) = lower(d.signer_email)
)
SELECT cohort_label,
       COUNT(*)                                       AS enrolled,
       COUNT(*) FILTER (WHERE last_email_sent_at IS NOT NULL) AS emails_sent_at_least_once,
       COUNT(*) FILTER (WHERE last_opened_at IS NOT NULL)     AS opened_at_least_once,
       COUNT(*) FILTER (WHERE last_clicked_at IS NOT NULL)    AS clicked_at_least_once,
       COUNT(*) FILTER (WHERE consultation_booked)            AS booked,
       COUNT(*) FILTER (WHERE unsubscribed)                   AS unsubscribed
  FROM cohort
 GROUP BY cohort_label
 ORDER BY enrolled DESC;

-- ====================================================================
-- 2. Borrower-clean cohort, the ones we ACTUALLY want engaging
-- ====================================================================
-- If borrower_clean has non-zero opens here, audience filter is the
-- only bug. If borrower_clean is also at 0 opens, deliverability is
-- broken too (check sender reputation / SPF / DKIM / Mail-Tester).

SELECT signer_email, entity_name, drip_stage,
       last_email_sent_at, last_opened_at, last_clicked_at,
       unsubscribed, consultation_booked
  FROM public.compliance_drip d
  LEFT JOIN public.profiles p ON lower(p.email) = lower(d.signer_email)
 WHERE p.id IS NULL
   AND split_part(lower(d.signer_email), '@', 2) NOT IN
       ('teamcenterstone.com', 'statewidecdc.com', 'moderntax.io', 'moderntax.com')
 ORDER BY last_email_sent_at DESC NULLS LAST
 LIMIT 50;

-- ====================================================================
-- 3. SendGrid event-level cross-check (raw)
-- ====================================================================
-- If compliance_drip's last_opened_at is all NULL but sendgrid_events
-- has 'open' events for these recipients, the join from events back to
-- the drip row is broken (likely a missing email-fingerprint column).

SELECT event, COUNT(*) AS n,
       MIN(event_timestamp) AS first_seen,
       MAX(event_timestamp) AS last_seen
  FROM public.sendgrid_events
 WHERE recipient_email IN (SELECT signer_email FROM public.compliance_drip)
 GROUP BY event
 ORDER BY n DESC;

-- ====================================================================
-- 4. Domain breakdown — surfaces any other internal-looking domains
-- ====================================================================
-- If you spot a domain that should be on the denylist
-- (CLIENT_DOMAIN_DENYLIST in lib/compliance-drip.ts), tell me and I'll
-- add it.

SELECT split_part(lower(signer_email), '@', 2) AS domain,
       COUNT(*) AS enrolled,
       COUNT(*) FILTER (WHERE last_opened_at IS NOT NULL) AS opened
  FROM public.compliance_drip
 GROUP BY 1
 ORDER BY enrolled DESC;
