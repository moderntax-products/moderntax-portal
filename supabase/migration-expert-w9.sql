-- Expert W-9 on file, for the self-serve Payouts page.
--
-- Experts download a blank W-9 (IRS link), sign it, and upload it from
-- /expert/payouts. The signed PDF's storage path lands here so admin/payroll
-- knows whose W-9 is on file before issuing a payout / 1099.
--
-- Apply in Supabase Studio (no programmatic DDL available).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS w9_url text,
  ADD COLUMN IF NOT EXISTS w9_uploaded_at timestamptz;
