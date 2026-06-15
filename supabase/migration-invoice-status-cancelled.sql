-- Allow 'cancelled' / 'processing' / 'void' invoice statuses so the portal can
-- reconcile with Mercury (which voids + reissues invoices). The old constraint
-- only allowed draft/sent/paid/overdue, so every Mercury 'Cancelled' write
-- silently failed — leaving cancelled invoices stuck as 'sent' and inflating AR.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('draft','sent','paid','overdue','cancelled','processing','void'));
