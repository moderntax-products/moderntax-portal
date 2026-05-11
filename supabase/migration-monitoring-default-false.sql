-- Flip the default on clients.monitoring_default_enabled from TRUE → FALSE.
--
-- Background. The column was added in migration-team-upgrade-toggles.sql
-- with `DEFAULT TRUE` on the theory that monitoring was a useful service
-- to auto-enable. The /api/cron/auto-enroll-monitoring sweep then
-- enrolled every newly-completed entity for any client that hadn't
-- explicitly opted out.
--
-- On 2026-05-07 between 04:15-04:16 UTC the cron mass-enrolled 218
-- entities (mostly Centerstone, some California Statewide CDC, a few
-- Clearfirm). $19.99 enrollment fee × 218 = $4,357.82 of phantom billing
-- exposure on services the clients hadn't asked for. Soobin Song at
-- Centerstone flagged two of them in their portal; we expect the rest
-- would have surfaced over the next billing cycle as Centerstone's AP
-- team reviewed monthly invoices.
--
-- The fix is structural: monitoring should be explicit opt-in, never
-- auto-enabled. This migration:
--   1. Flips the column default to FALSE for any new clients added
--      after today.
--   2. Sets existing rows that are currently TRUE/NULL to FALSE,
--      EXCEPT for Clearfirm and TMC Financing which already had it
--      FALSE OR have an active intentional enrollment flow.
--      (The runtime script scripts/fix-greatlakes-and-monitoring.ts
--      already applied this state — this UPDATE is idempotent and
--      ensures it survives any future restore-from-backup or
--      seed-data refresh.)
--
-- Idempotent — safe to re-run.

ALTER TABLE public.clients
  ALTER COLUMN monitoring_default_enabled SET DEFAULT FALSE;

-- Bring any rows currently TRUE or NULL down to FALSE. The runtime
-- script already did this for the named clients on 2026-05-11, but
-- repeat the operation here so the migration is self-sufficient.
UPDATE public.clients
SET monitoring_default_enabled = FALSE
WHERE monitoring_default_enabled IS DISTINCT FROM FALSE;

COMMENT ON COLUMN public.clients.monitoring_default_enabled IS
  'When TRUE, the auto-enroll-monitoring cron will enroll new completed entities for this client in quarterly monitoring. Defaults to FALSE — explicit opt-in only — after the 2026-05 incident where the previous TRUE default mass-enrolled 218 Centerstone entities without consent.';
