-- Persist the per-processor / per-entity invoice breakdown alongside the
-- invoice row so the manager portal can render the same itemization the
-- AP team received in their SendGrid email.
--
-- Driver: 2026-05-29 Matt — "the itemized breakdown of all entities per
-- processor is what needs to accompany each Mercury invoice link it
-- needs to be sent through SendGrid and live in the managers portal."
-- SendGrid covers the email; this column makes the breakdown durable in
-- the portal's /invoicing surface.
--
-- Shape (matches what /api/admin/send-test-may-invoice returns in the
-- `breakdown` key of its response):
--   {
--     processor_groups: [
--       { processor: "Sonja Lewis",
--         entities: [{ entity_name, form_type, completed_at, loan_number,
--                      unit_price, is_reorder }],
--         subtotal: 239.94 },
--       ...
--     ],
--     monitoring_details: [
--       { entity_name, processor, window_start, window_end, active_days,
--         prorated },
--       ...
--     ],
--     catchup_line: { amount: 260.32, memo: "..." } | null
--   }

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS breakdown JSONB;

COMMENT ON COLUMN public.invoices.breakdown IS
  'Per-processor + per-entity + per-monitoring-enrollment breakdown for the manager-facing portal. Same JSON shape as the SendGrid email body. NULL on legacy rows where the breakdown was not captured; future rows from the auto-invoice cron + admin endpoints will populate it.';
