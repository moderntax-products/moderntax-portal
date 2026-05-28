-- Team Upgrade toggles + Cash-Flow Pack billing scaffold
--
-- Adds two boolean flags to `clients` controlling lender-wide add-on defaults:
--
--   monitoring_default_enabled (DEFAULT TRUE)
--     When true (the default), every entity that reaches status='completed'
--     auto-enrolls in continuous monitoring (quarterly transcript pulls,
--     $19.99 enrollment + $39.99/pull). Manager toggles this in the
--     "Upgrade Your Team" panel on the dashboard. Set to false on a
--     per-client basis when the lender wants to opt out of default-on.
--
--     Existing clients default to TRUE so the new behaviour starts
--     immediately. Lenders that don't want monitoring on by default flip it
--     OFF in the dashboard panel.
--
--   cash_flow_auto_attach (DEFAULT FALSE)
--     When true, every completed entity automatically generates a Cash-Flow
--     Analysis Pack ($49.99/loan) and bills it via the next invoice cycle.
--     When false (default), processors generate per-loan via the
--     CashFlowPackButton on each completed entity card. Default-OFF is
--     intentional — auto-attach implies a recurring cost the lender
--     should opt INTO, not be opted into.
--
-- Idempotent — safe to run multiple times.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS monitoring_default_enabled BOOLEAN DEFAULT TRUE;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS cash_flow_auto_attach BOOLEAN DEFAULT FALSE;

-- Backfill: ensure any existing rows where the column was just added land at
-- the default. (No-op when the column was already present.)
UPDATE public.clients SET monitoring_default_enabled = TRUE WHERE monitoring_default_enabled IS NULL;
UPDATE public.clients SET cash_flow_auto_attach     = FALSE WHERE cash_flow_auto_attach     IS NULL;

COMMENT ON COLUMN public.clients.monitoring_default_enabled IS
  'When true, entity completion auto-enrolls in continuous monitoring. Manager toggles via dashboard.';
COMMENT ON COLUMN public.clients.cash_flow_auto_attach IS
  'When true, every completed entity auto-generates the $49.99 Cash-Flow Analysis Pack on completion.';

-- ---------------------------------------------------------------------------
-- Cash-Flow Pack tracking
--
-- We deliberately store cash_flow_pack metadata as a JSON key inside
-- request_entities.gross_receipts (under the key 'cash_flow_pack'), NOT as a
-- new table. Rationale: gross_receipts is the established convention for
-- per-entity attestations (compliance flags, entity transcript, etc.) and the
-- auto-invoice cron already reads/writes this column. Adding a sibling table
-- would require a join + a separate idempotency strategy.
--
-- Shape of the JSON value (created by /api/cash-flow/generate, marked billed
-- by /api/cron/auto-invoice):
--   {
--     "generated_at": "2026-05-04T22:11:00Z",
--     "generated_by": "<uuid>",
--     "generated_by_name": "Robin Kim",
--     "pdf_url": "cash-flow-packs/<entityId>/<ts>-cash-flow-pack.pdf",
--     "price": 49.99,
--     "years_covered": 3,
--     "year_range": "2024, 2023, 2022",
--     "billed": true,
--     "billed_at": "2026-06-01T06:00:00Z",
--     "invoice_id": "<uuid>",
--     "invoice_number": "INV-2026-06-CENT"
--   }
--
-- Index for the auto-invoice cron's "find unbilled packs in this period" query.
-- Uses a partial expression index on billed=false. Postgres needs the
-- jsonb_extract_path_text wrapped in IS NOT NULL to be index-eligible.
CREATE INDEX IF NOT EXISTS idx_request_entities_cash_flow_pack_unbilled
  ON public.request_entities ((gross_receipts->'cash_flow_pack'->>'billed'))
  WHERE gross_receipts->'cash_flow_pack' IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Verification queries (uncomment in psql to confirm post-migration state):
--
-- SELECT id, name, monitoring_default_enabled, cash_flow_auto_attach
-- FROM public.clients ORDER BY name;
--
-- SELECT count(*) FROM public.request_entities
-- WHERE gross_receipts ? 'cash_flow_pack'
--   AND (gross_receipts->'cash_flow_pack'->>'billed')::bool = false;
