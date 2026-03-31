-- Migration: Invoice & Billing System
-- MOD-120: Portal: Invoice & Billing Section (Manager View)
-- Adds invoices table and billing settings to clients

-- ============================================================
-- 1. Add billing settings columns to clients table
-- ============================================================
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS billing_payment_method TEXT DEFAULT NULL
    CHECK (billing_payment_method IS NULL OR billing_payment_method IN ('ach', 'wire')),
  ADD COLUMN IF NOT EXISTS billing_ap_email TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS billing_ap_phone TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS billing_rate_pdf NUMERIC(10,2) DEFAULT 59.98,
  ADD COLUMN IF NOT EXISTS billing_rate_csv NUMERIC(10,2) DEFAULT 69.98;

-- ============================================================
-- 2. Create invoices table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL,
  billing_period_start DATE NOT NULL,
  billing_period_end DATE NOT NULL,
  total_entities INTEGER NOT NULL DEFAULT 0,
  total_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'paid', 'overdue')),
  payment_method TEXT DEFAULT NULL
    CHECK (payment_method IS NULL OR payment_method IN ('ach', 'wire')),
  mercury_reference TEXT DEFAULT NULL,
  due_date DATE DEFAULT NULL,
  sent_at TIMESTAMPTZ DEFAULT NULL,
  paid_at TIMESTAMPTZ DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(client_id, billing_period_start, billing_period_end)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_invoices_client_id ON public.invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON public.invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_billing_period ON public.invoices(billing_period_start, billing_period_end);

-- RLS
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

-- Admins can do everything
CREATE POLICY "admins_full_access_invoices" ON public.invoices
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Managers can read their own client's invoices
CREATE POLICY "managers_read_own_invoices" ON public.invoices
  FOR SELECT
  USING (
    client_id IN (
      SELECT client_id FROM public.profiles WHERE id = auth.uid() AND role = 'manager'
    )
  );

-- Service role bypass (for cron jobs)
CREATE POLICY "service_role_invoices" ON public.invoices
  FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================
-- 3. Updated_at trigger for invoices
-- ============================================================
CREATE OR REPLACE FUNCTION update_invoices_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS invoices_updated_at ON public.invoices;
CREATE TRIGGER invoices_updated_at
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION update_invoices_updated_at();

-- ============================================================
-- 4. Seed historical invoices for Centerstone SBA Lending
--    Amounts from actual Mercury invoices (INV-4 through INV-15)
-- ============================================================
-- Centerstone client_id: 60f80d60-03ad-42d7-95da-c0f1cd311523
-- Billing to: Mathew.paek@teamcenterstone.com
-- Payment: ACH/Wire via Mercury

-- INV-4: Oct 9, 2025 — Tax Verification Usage (lump sum) — PAID
INSERT INTO public.invoices (client_id, invoice_number, billing_period_start, billing_period_end, total_entities, total_amount, status, payment_method, due_date, sent_at, paid_at, mercury_reference, notes)
VALUES (
  '60f80d60-03ad-42d7-95da-c0f1cd311523',
  'INV-4',
  '2025-10-09',
  '2025-11-08',
  0,
  1479.17,
  'paid',
  'ach',
  '2025-11-08',
  '2025-10-09T00:00:00Z',
  '2025-11-08T00:00:00Z',
  'INV-4',
  'Tax Verification Usage (Centerstone). Lump sum first invoice.'
);

-- INV-6: Nov 10, 2025 — 29 entities @ $49.99 + 29 ROA @ $9.99 = $1,739.42 — PAID
INSERT INTO public.invoices (client_id, invoice_number, billing_period_start, billing_period_end, total_entities, total_amount, status, payment_method, due_date, sent_at, paid_at, mercury_reference, notes)
VALUES (
  '60f80d60-03ad-42d7-95da-c0f1cd311523',
  'INV-6',
  '2025-11-10',
  '2025-11-17',
  29,
  1739.42,
  'paid',
  'ach',
  '2025-11-17',
  '2025-11-10T00:00:00Z',
  '2025-11-17T00:00:00Z',
  'INV-6',
  '29 entities. Tax Verification (Return + ROA) @ $49.99 + Tax Return ROA @ $9.99.'
);

-- INV-8: Dec 10, 2025 — 55 entities @ $59.99 = $3,299.45 — PAID
INSERT INTO public.invoices (client_id, invoice_number, billing_period_start, billing_period_end, total_entities, total_amount, status, payment_method, due_date, sent_at, paid_at, mercury_reference, notes)
VALUES (
  '60f80d60-03ad-42d7-95da-c0f1cd311523',
  'INV-8',
  '2025-11-11',
  '2025-12-10',
  55,
  3299.45,
  'paid',
  'ach',
  '2025-12-17',
  '2025-12-10T00:00:00Z',
  '2025-12-17T00:00:00Z',
  'INV-8',
  '55 entities. Tax Verification Services (Return + ROA) @ $59.99.'
);

-- INV-11: Jan 12, 2026 — 38 entities @ $59.98 = $2,279.24 — PAID
INSERT INTO public.invoices (client_id, invoice_number, billing_period_start, billing_period_end, total_entities, total_amount, status, payment_method, due_date, sent_at, paid_at, mercury_reference, notes)
VALUES (
  '60f80d60-03ad-42d7-95da-c0f1cd311523',
  'INV-11',
  '2025-12-11',
  '2026-01-12',
  38,
  2279.24,
  'paid',
  'ach',
  '2026-01-20',
  '2026-01-12T00:00:00Z',
  '2026-01-20T00:00:00Z',
  'INV-11',
  '38 entities. Tax Verification Services (Return + ROA) @ $59.98.'
);

-- INV-14: Feb 12, 2026 — 55 entities @ $59.99 = $3,299.45 — PAID
INSERT INTO public.invoices (client_id, invoice_number, billing_period_start, billing_period_end, total_entities, total_amount, status, payment_method, due_date, sent_at, paid_at, mercury_reference, notes)
VALUES (
  '60f80d60-03ad-42d7-95da-c0f1cd311523',
  'INV-14',
  '2026-01-13',
  '2026-02-12',
  55,
  3299.45,
  'paid',
  'ach',
  '2026-02-19',
  '2026-02-12T00:00:00Z',
  '2026-02-19T00:00:00Z',
  'INV-14',
  '55 entities. Tax Verification Services (Return + ROA) @ $59.99.'
);

-- INV-15: Mar 12, 2026 — 18 entities @ $59.98 + 10 discovery @ $17.99 = $1,259.54 — PAID
INSERT INTO public.invoices (client_id, invoice_number, billing_period_start, billing_period_end, total_entities, total_amount, status, payment_method, due_date, sent_at, paid_at, mercury_reference, notes)
VALUES (
  '60f80d60-03ad-42d7-95da-c0f1cd311523',
  'INV-15',
  '2026-02-13',
  '2026-03-12',
  18,
  1259.54,
  'paid',
  'ach',
  '2026-03-19',
  '2026-03-12T00:00:00Z',
  '2026-03-19T00:00:00Z',
  'INV-15',
  '18 entities @ $59.98 + 10 entity discovery @ $17.99. Tax Verification + Entity Discovery.'
);

-- Set Centerstone billing preferences (AP contact: Mathew Paek)
UPDATE public.clients
SET
  billing_payment_method = 'ach',
  billing_ap_email = 'Mathew.paek@teamcenterstone.com',
  billing_ap_phone = NULL
WHERE id = '60f80d60-03ad-42d7-95da-c0f1cd311523';
