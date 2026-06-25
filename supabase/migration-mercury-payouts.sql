-- Mercury expert payouts — link experts to Mercury recipients + track the
-- approval-gated send-money request per pay period.
--
-- We never store bank details (Mercury holds them on the recipient). We only
-- store the recipient id and the send-money request id/status so the admin
-- payroll view can show "drafted in Mercury — pending your approval."
--
-- Apply in Supabase Studio.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS mercury_recipient_id text;

ALTER TABLE public.expert_pay_periods
  ADD COLUMN IF NOT EXISTS mercury_payout_request_id text,
  ADD COLUMN IF NOT EXISTS mercury_payout_status text,        -- e.g. 'pendingApproval' | 'approved' | 'rejected'
  ADD COLUMN IF NOT EXISTS mercury_payout_drafted_at timestamptz;
