-- SOC 2 phase 2: close remaining RLS + SECURITY DEFINER findings in one go
--
-- Closes:
--   MOD-186  — Enable RLS on the 19 remaining public tables
--   MOD-187  — Remove SECURITY DEFINER from 8 public views
--
-- Also cleans up a side-effect of Phase 1 (migration-rls-critical-tables.sql):
-- the service_role policies we added there were flagged by the linter's new
-- `rls_policy_always_true` rule. service_role bypasses RLS by design so the
-- explicit policies are redundant — we drop them.
--
-- Why no per-tenant policies yet:
-- The goal of this phase is to close the SOC 2 ERROR findings TODAY.
-- Per-tenant SELECT policies (anon / authenticated with JOIN to client_id)
-- require per-table design and will be tracked as follow-up work. Until then,
-- service_role continues to work via its built-in bypass; anon/authenticated
-- reads of these tables (none today, confirmed by grep) will return zero rows.
--
-- Why ALTER VIEW instead of DROP+CREATE for views:
-- Postgres 15+ supports `ALTER VIEW ... SET (security_invoker = true)` which
-- flips the view's security context without rewriting its body. Much safer
-- than reproducing the view definitions from pg_get_viewdef output.

BEGIN;

-- ===========================================================================
-- Part 1 — Enable RLS on remaining 19 tables
-- ===========================================================================

-- Tier 1: PII / customer data (8 tables)
ALTER TABLE public.contacts                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experts                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_interactions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.irs_documents            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parsed_transcripts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loan_entities            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_requests    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_verification_requests ENABLE ROW LEVEL SECURITY;

-- Tier 2: financial / workflow state (5 tables)
ALTER TABLE public.transactions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcript_files         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_requests             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_form_mappings   ENABLE ROW LEVEL SECURITY;

-- Tier 3: infra / telemetry (6 tables)
ALTER TABLE public.callback_attempts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upload_activity          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_performance_logs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processing_errors        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_entity_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entity_monitoring        ENABLE ROW LEVEL SECURITY;

-- ===========================================================================
-- Part 2 — Convert 8 SECURITY DEFINER views to SECURITY INVOKER
-- ===========================================================================

ALTER VIEW public.pending_business_entity_reviews SET (security_invoker = true);
ALTER VIEW public.daily_upload_stats              SET (security_invoker = true);
ALTER VIEW public.form_8821_requests              SET (security_invoker = true);
ALTER VIEW public.pending_callbacks               SET (security_invoker = true);
ALTER VIEW public.agent_performance_issues        SET (security_invoker = true);
ALTER VIEW public.team_summary                    SET (security_invoker = true);
ALTER VIEW public.expert_performance              SET (security_invoker = true);
ALTER VIEW public.business_request_analytics      SET (security_invoker = true);

-- ===========================================================================
-- Part 3 — Drop redundant service_role policies added in Phase 1
-- These triggered the linter's `rls_policy_always_true` rule because
-- `USING (true) WITH CHECK (true)` for `FOR ALL` is a permissive pattern.
-- service_role bypasses RLS regardless, so the policies are cosmetic.
-- ===========================================================================

DROP POLICY IF EXISTS "service_role_all_api_keys"               ON public.api_keys;
DROP POLICY IF EXISTS "service_role_all_api_usage"              ON public.api_usage;
DROP POLICY IF EXISTS "service_role_all_expert_schedule_tokens" ON public.expert_schedule_tokens;
DROP POLICY IF EXISTS "service_role_all_transcript_requests"    ON public.transcript_requests;

COMMIT;

-- ===========================================================================
-- Verification (run after commit):
-- ===========================================================================
--
-- 1. All target tables should show rowsecurity=true:
--
--   SELECT tablename, rowsecurity
--     FROM pg_tables
--    WHERE schemaname = 'public'
--      AND tablename IN (
--        'contacts','experts','email_interactions','irs_documents',
--        'parsed_transcripts','loan_entities','verification_requests',
--        'tax_verification_requests','transactions','transcript_files',
--        'api_requests','organizations','business_form_mappings',
--        'callback_attempts','upload_activity','agent_performance_logs',
--        'processing_errors','business_entity_candidates','entity_monitoring'
--      );
--
-- 2. All 8 views should show security_invoker:
--
--   SELECT c.relname AS view_name,
--          (unnest(c.reloptions))
--     FROM pg_class c
--     JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public'
--      AND c.relkind = 'v'
--      AND c.relname IN (
--        'pending_business_entity_reviews','daily_upload_stats',
--        'form_8821_requests','pending_callbacks',
--        'agent_performance_issues','team_summary',
--        'expert_performance','business_request_analytics'
--      );
--
-- 3. The four service_role_all_* policies should no longer exist:
--
--   SELECT policyname FROM pg_policies
--    WHERE schemaname = 'public'
--      AND policyname LIKE 'service_role_all_%';
--   -- (should return 0 rows)
