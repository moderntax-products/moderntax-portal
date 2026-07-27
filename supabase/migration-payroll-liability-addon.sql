-- Payroll-Liability Report add-on (2026-07-25)
--
-- SBA-lender feature: pull an entity's Form 941 (employer quarterly payroll)
-- account transcripts and report any outstanding payroll-tax liability. The
-- per-order flag lives on request_entities.gross_receipts.payroll_liability_order
-- (JSONB, no column needed). This migration adds only the CLIENT-level
-- auto-attach toggle, mirroring clients.cash_flow_auto_attach.
--
-- When TRUE, every new order the client places auto-includes the report — the
-- going-forward ask from California Statewide CDC. Defaults FALSE so no other
-- client's billing changes.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS payroll_liability_auto_attach BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN clients.payroll_liability_auto_attach IS
  'When true, every new order auto-includes the Payroll-Liability (Form 941) Report add-on. Mirrors cash_flow_auto_attach. SBA-lender feature 2026-07-25.';

-- Index only the opted-in rows (overwhelmingly false).
CREATE INDEX IF NOT EXISTS idx_clients_payroll_liability_auto_attach
  ON clients (id) WHERE payroll_liability_auto_attach = TRUE;
