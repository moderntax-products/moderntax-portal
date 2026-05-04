-- Track which invoices have had their itemized breakdown PDF sent.
--
-- Per Matt 2026-05-04: every Mercury invoice should automatically get
-- the breakdown PDF as a follow-up email — but only ONCE. Future dunning
-- reminders for the same unpaid invoice should NOT re-attach the
-- breakdown (just send the payment reminder).
--
-- Idempotent.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS breakdown_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN public.invoices.breakdown_sent_at IS
  'Timestamp the itemized breakdown PDF was emailed to the AP recipient. Set once after the first successful Mercury create + breakdown send. Future reminder emails check this and skip re-attaching the breakdown.';

-- Add Jasmine Kim as Centerstone billing CC (per the original SOW —
-- Customer Billing Contact = Jasmine Kim).
UPDATE public.clients
SET billing_ap_email_cc = ARRAY['jasmine.kim@teamcenterstone.com']
WHERE slug = 'centerstone'
  AND (billing_ap_email_cc IS NULL OR array_length(billing_ap_email_cc, 1) IS NULL);
