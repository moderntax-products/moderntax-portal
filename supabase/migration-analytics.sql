-- ============================================================
-- Analytics Events Table
-- Tracks page views, signups, key actions, and usage metrics
-- ============================================================

-- Create analytics_events table
CREATE TABLE IF NOT EXISTS analytics_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Event identification
  event_type TEXT NOT NULL,              -- 'page_view', 'signup', 'login', 'request_created', 'transcript_downloaded', etc.
  event_category TEXT NOT NULL DEFAULT 'general',  -- 'navigation', 'auth', 'request', 'transcript', 'admin'

  -- User context (nullable for anonymous events)
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  user_email TEXT,
  user_role TEXT,                        -- 'processor', 'manager', 'admin', 'expert'
  client_id UUID,                        -- Which client org the user belongs to

  -- Event data
  page_path TEXT,                        -- e.g., '/admin/requests/123'
  referrer TEXT,                         -- Where they came from
  metadata JSONB DEFAULT '{}',           -- Flexible event-specific data

  -- Device/session context
  session_id TEXT,                       -- Browser session identifier
  user_agent TEXT,
  ip_address TEXT,
  country TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_analytics_events_type ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user ON analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_category ON analytics_events(event_category);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session ON analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_page ON analytics_events(page_path);

-- Composite index for dashboard queries
CREATE INDEX IF NOT EXISTS idx_analytics_events_type_date ON analytics_events(event_type, created_at DESC);

-- RLS
ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;

-- Admins can read all analytics
CREATE POLICY analytics_admin_read ON analytics_events
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

-- Service role can insert (used by API routes)
-- No user-level insert policy — events are logged via admin/service client

-- Daily aggregation view for fast dashboard queries
CREATE OR REPLACE VIEW analytics_daily_summary AS
SELECT
  DATE(created_at) AS day,
  event_type,
  event_category,
  COUNT(*) AS event_count,
  COUNT(DISTINCT user_id) AS unique_users,
  COUNT(DISTINCT session_id) AS unique_sessions,
  COUNT(DISTINCT client_id) AS unique_clients
FROM analytics_events
GROUP BY DATE(created_at), event_type, event_category
ORDER BY day DESC, event_count DESC;

-- Grant access to the view
GRANT SELECT ON analytics_daily_summary TO authenticated;

-- Function to get analytics summary for a date range
CREATE OR REPLACE FUNCTION get_analytics_summary(
  start_date TIMESTAMPTZ DEFAULT NOW() - INTERVAL '30 days',
  end_date TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE(
  total_page_views BIGINT,
  unique_visitors BIGINT,
  total_signups BIGINT,
  total_logins BIGINT,
  total_requests_created BIGINT,
  total_transcripts_downloaded BIGINT,
  avg_daily_active_users NUMERIC
)
LANGUAGE SQL
SECURITY DEFINER
AS $$
  SELECT
    COUNT(*) FILTER (WHERE event_type = 'page_view') AS total_page_views,
    COUNT(DISTINCT user_id) AS unique_visitors,
    COUNT(*) FILTER (WHERE event_type = 'signup') AS total_signups,
    COUNT(*) FILTER (WHERE event_type = 'login') AS total_logins,
    COUNT(*) FILTER (WHERE event_type = 'request_created') AS total_requests_created,
    COUNT(*) FILTER (WHERE event_type = 'transcript_downloaded') AS total_transcripts_downloaded,
    ROUND(
      COUNT(DISTINCT user_id)::NUMERIC / GREATEST(1, EXTRACT(DAY FROM end_date - start_date)),
      1
    ) AS avg_daily_active_users
  FROM analytics_events
  WHERE created_at >= start_date AND created_at <= end_date;
$$;
