-- SOC 2 CR-6 — enable RLS on erc_check_reissues. The table was created
-- 2026-05-15 (post Phase-1 + Phase-2 RLS sweeps) and slipped through
-- the default-deny posture established for every other PII table.
--
-- Posture: service-role bypass continues to work for all server-side
-- code paths (token-gated merchant page, intake API, admin tooling).
-- Anon/authenticated reads default-deny until per-tenant SELECT policies
-- are written (MOD-186 follow-up — same gap noted on the Phase-2
-- table list in migration-rls-sweep-and-views.sql).
--
-- Apply via: Supabase Dashboard → SQL Editor → paste + Run.

ALTER TABLE public.erc_check_reissues ENABLE ROW LEVEL SECURITY;

-- Quick verification:
--   SELECT relname, relrowsecurity
--   FROM pg_class
--   WHERE relname = 'erc_check_reissues';
--   -- relrowsecurity should be 't' after applying.
