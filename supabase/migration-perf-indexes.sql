-- Performance index pass — Tier 1 (post-Supabase-Pro, 2026-07-17)
-- Targets the hot query paths in the cron fleet + admin dashboards. Focused on
-- foreign-key columns (Postgres never auto-indexes FKs) and the exact filters
-- the schedulers run every few minutes. All IF NOT EXISTS — safe to re-run.
--
-- Tables here are modest, so a plain CREATE INDEX (brief write lock) is fine.
-- If any of these grow into the millions, switch that line to
-- CREATE INDEX CONCURRENTLY (run it on its own, outside a transaction).

-- request_entities.request_id — joined on every requests!inner lookup and the
-- request→entity rollups (auto-complete, webhook, email-intake matcher). FK, unindexed.
CREATE INDEX IF NOT EXISTS idx_re_request_id ON public.request_entities(request_id);

-- request_entities.status — scanned by auto-assign-experts, stuck-entity-alert,
-- processor-delay-digest, and the signed-8821 email matcher.
CREATE INDEX IF NOT EXISTS idx_re_status ON public.request_entities(status);

-- The signed-8821 email matcher: client's entities still awaiting an 8821.
-- Partial index keeps it tiny and exactly matches the WHERE.
CREATE INDEX IF NOT EXISTS idx_re_awaiting_8821 ON public.request_entities(status)
  WHERE signed_8821_url IS NULL;

-- expert_assignments — the active-assignment guard (entity_id + status) runs on
-- every assign/auto-assign; batch_id drives accept/expire. Both FKs, unindexed.
CREATE INDEX IF NOT EXISTS idx_ea_entity_status ON public.expert_assignments(entity_id, status);
CREATE INDEX IF NOT EXISTS idx_ea_batch_id      ON public.expert_assignments(batch_id);

-- assignment_batches — the two expiry sweeps filter status + a deadline.
CREATE INDEX IF NOT EXISTS idx_ab_pending_acceptance ON public.assignment_batches(acceptance_deadline)
  WHERE status = 'pending_acceptance';
CREATE INDEX IF NOT EXISTS idx_ab_accepted_completion ON public.assignment_batches(completion_deadline)
  WHERE status = 'accepted';

-- expert_time_logs — idle-cleanup finds still-open sessions; daily-cogs scans by start.
CREATE INDEX IF NOT EXISTS idx_etl_open ON public.expert_time_logs(expert_id)
  WHERE end_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_etl_start ON public.expert_time_logs(start_at);
