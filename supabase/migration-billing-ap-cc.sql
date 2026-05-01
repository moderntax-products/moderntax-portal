-- Add CC support for AP email + populate Clearfirm and TMC billing contacts.
--
-- Mercury's invoice API already supports a ccEmails array; we just need a
-- place to store the per-client recipient list. Matt 2026-05-01 directive:
--   - Clearfirm invoices to ap@getclearfirm.com, CC matt@getclearfirm.com.
--   - TMC Financing invoices to grace@tmcfinancing.com, CC kisha@tmcfinancing.com.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS billing_ap_email_cc TEXT[] DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN public.clients.billing_ap_email_cc IS
  'CC recipients on every Mercury invoice for this client. The primary recipient is billing_ap_email; this array adds additional contacts (e.g., a controller, a partner, a centralized AP inbox).';

-- Clearfirm — primary AP + Matt CC'd on every invoice
UPDATE public.clients
SET billing_ap_email    = 'ap@getclearfirm.com',
    billing_ap_email_cc = ARRAY['matt@getclearfirm.com']
WHERE slug = 'clearfirm';

-- TMC Financing — Grace primary, Kisha CC'd
UPDATE public.clients
SET billing_ap_email    = 'grace@tmcfinancing.com',
    billing_ap_email_cc = ARRAY['kisha@tmcfinancing.com']
WHERE slug = 'tmc';
