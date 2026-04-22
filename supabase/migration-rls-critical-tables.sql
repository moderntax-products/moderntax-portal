-- SOC 2 emergency RLS hardening — MOD-188 (sensitive cols) + MOD-186 head-start
--
-- Enables Row-Level Security on 4 tables that Supabase's database linter
-- flagged as exposing credentials or PII without RLS protection. The linter
-- called these out with severity ERROR, facing EXTERNAL.
--
--   public.api_keys                   — credential storage (key_hash, secret_preview)
--   public.api_usage                  — includes api_key column, 147 rows
--   public.expert_schedule_tokens     — magic-link token for schedule confirmation
--   public.transcript_requests        — includes ssn column, 4 rows of taxpayer PII
--
-- Why deny-all is safe:
--
--   • Supabase's `service_role` key (used by createAdminClient() everywhere in
--     our API routes) BYPASSES RLS entirely — no policies required for server-
--     side code to keep working.
--   • The `anon` key (used by the browser client via createBrowserClient())
--     never reads these tables today. Grep across app/ and lib/ confirms every
--     usage of expert_schedule_tokens goes through createAdminClient() via
--     `(supabase as any).from('expert_schedule_tokens' as any)...`. The other
--     three tables aren't read by client code at all.
--   • No tenant-specific SELECT policies are added yet — per-tenant access will
--     be designed as part of MOD-186 (the broader 22-table sweep). Until then
--     deny-all is the correct interim posture: locked to authenticated users,
--     service role still works, SOC 2 linter goes green.
--
-- If a regression surfaces because some code path was using the anon or
-- authenticated key to read one of these tables, the error will be "0 rows
-- returned" rather than a data-access crash. Search for such code paths and
-- either (a) switch them to use createAdminClient(), or (b) add an explicit
-- policy scoped to that use case.
--
-- Related tickets:
--   MOD-186  Broader 22-table RLS rollout
--   MOD-187  Remove SECURITY DEFINER from 8 views
--   MOD-188  Sensitive-column protection (this migration is the MVP fix for it)
--
-- Remediation docs:
--   https://supabase.com/docs/guides/database/database-linter?lint=0013_rls_disabled_in_public
--   https://supabase.com/docs/guides/database/database-linter?lint=0023_sensitive_columns_exposed

BEGIN;

-- -------------------------------------------------------------------------
-- 1. api_keys — credential rows.
-- -------------------------------------------------------------------------
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- Explicitly grant service_role access even though it bypasses RLS — keeps
-- the intent visible in pg_policies and avoids surprises if the default
-- bypass behaviour ever changes.
CREATE POLICY "service_role_all_api_keys"
  ON public.api_keys
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- -------------------------------------------------------------------------
-- 2. api_usage — log rows that include an api_key column.
-- -------------------------------------------------------------------------
ALTER TABLE public.api_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_api_usage"
  ON public.api_usage
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- -------------------------------------------------------------------------
-- 3. expert_schedule_tokens — magic-link tokens used by
--    /api/expert/schedule/{verify,confirm} and the daily schedule cron.
--    All three call sites use createAdminClient() (service_role), so RLS
--    does not affect them. Anon/authenticated reads are blocked by default.
-- -------------------------------------------------------------------------
ALTER TABLE public.expert_schedule_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_expert_schedule_tokens"
  ON public.expert_schedule_tokens
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- -------------------------------------------------------------------------
-- 4. transcript_requests — taxpayer PII including ssn.
-- -------------------------------------------------------------------------
ALTER TABLE public.transcript_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_transcript_requests"
  ON public.transcript_requests
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMIT;

-- Verification — run after the migration to confirm all 4 tables have RLS on.
-- Every row should show rowsecurity = true and at least the service_role policy.
--
--   SELECT schemaname, tablename, rowsecurity
--     FROM pg_tables
--    WHERE schemaname = 'public'
--      AND tablename IN ('api_keys', 'api_usage', 'expert_schedule_tokens', 'transcript_requests');
--
--   SELECT schemaname, tablename, policyname, roles
--     FROM pg_policies
--    WHERE schemaname = 'public'
--      AND tablename IN ('api_keys', 'api_usage', 'expert_schedule_tokens', 'transcript_requests');
