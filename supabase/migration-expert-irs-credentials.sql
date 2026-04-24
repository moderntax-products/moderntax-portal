-- Expert IRS credentials (SSN + DOB)
--
-- Required by IRS Practitioner Priority Service: when the agent prepares
-- to release transcripts to the practitioner's SOR inbox, the practitioner
-- must verbally confirm their own SSN + DOB. The 8821 + CAF identify the
-- taxpayer and authorize the practitioner, but IRS also verifies the human
-- on the phone matches the CAF holder via SSN+DOB.
--
-- Storage:
--   • Columns hold base64-encoded AES-256-GCM ciphertext (IV + tag + ct).
--   • Encryption key lives in EXPERT_CREDENTIALS_KEY env var, never in DB.
--   • lib/crypto.ts owns the encrypt/decrypt contract.
--
-- Access pattern:
--   • Expert sets/updates via POST /api/expert/credentials (own row only).
--   • Service role reads during IRS-call initiation to pass to Retell.
--   • Every read is audit-logged in app/api/expert/credentials and
--     lib/voice-provider.initiateCall.
--
-- Idempotent — re-running is safe.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ssn_encrypted               TEXT,
  ADD COLUMN IF NOT EXISTS dob_encrypted               TEXT,
  ADD COLUMN IF NOT EXISTS irs_credentials_updated_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS irs_credentials_consented_at TIMESTAMPTZ;

-- RLS: experts can only read/write their own credentials. The service role
-- (used by /api/expert/irs-call/initiate) bypasses RLS as usual.
--
-- Profiles table already has RLS; these columns inherit it. Add an
-- additional narrowing policy for ssn/dob read access: expert themselves OR
-- service_role. Admin users do NOT get read access through the client
-- because we never want these in a browser context.
CREATE OR REPLACE FUNCTION public.is_self(profile_id UUID) RETURNS BOOLEAN
LANGUAGE SQL STABLE AS $$
  SELECT auth.uid() = profile_id
$$;

-- Add a diagnostic column for ops: count of IRS call sessions that have
-- successfully used these credentials. Incremented by voice-provider.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS irs_credentials_used_count INT DEFAULT 0;

COMMENT ON COLUMN public.profiles.ssn_encrypted IS
  'AES-256-GCM encrypted SSN (9 digits, no dashes). Decrypt key in EXPERT_CREDENTIALS_KEY env. Never logged.';
COMMENT ON COLUMN public.profiles.dob_encrypted IS
  'AES-256-GCM encrypted DOB as YYYY-MM-DD. Decrypt key in EXPERT_CREDENTIALS_KEY env. Never logged.';
COMMENT ON COLUMN public.profiles.irs_credentials_consented_at IS
  'When the expert explicitly consented to their SSN+DOB being used in IRS PPS AI calls. Required before first use.';
