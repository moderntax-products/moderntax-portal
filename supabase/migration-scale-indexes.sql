-- ============================================================
-- Scale Indexes Migration
-- Composite indexes for 6,803+ entity throughput
-- Run with CONCURRENTLY to avoid downtime
-- ============================================================

-- Request entities by status + created (for cron queries)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_request_entities_status_created
  ON public.request_entities(status, created_at);

-- Request entities by request + status (for completion checks)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_request_entities_request_status
  ON public.request_entities(request_id, status);

-- Requests by status + created (for auto-complete pagination)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_requests_status_created
  ON public.requests(status, created_at);

-- Expert assignments by expert + status (for load balancing)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_expert_assignments_expert_status
  ON public.expert_assignments(expert_id, status);

-- Webhook deliveries by status + next retry (for webhook-retry cron)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhook_deliveries_status_retry
  ON public.webhook_deliveries(status, next_retry_at)
  WHERE status IN ('pending', 'failed');
