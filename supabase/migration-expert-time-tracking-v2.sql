-- Expert time-tracking v2 — narrow to billable activities only.
--
-- Driver: 2026-05-21 — iCloud expert flagged that current logging is too
-- broad (he forgets to clock in/out, no way to differentiate the 3 real
-- billable activities from incidental browser time). The three events
-- that count for compensation:
--   1. Bland/Retell IRS call session (auto-detected via irs_call_sessions)
--   2. Manual IRS direct-dial (expert clicks "I'm calling IRS now")
--   3. SOR bookmarklet upload activity (auto-detected via batch-upload)
--
-- Existing expert_time_logs schema stays — we just add discriminators so
-- we can compute per-activity COGS attribution.

-- Add the discriminator columns. All optional so existing rows stay valid.
ALTER TABLE expert_time_logs
  ADD COLUMN IF NOT EXISTS kind text
    CHECK (kind IS NULL OR kind IN ('manual', 'bland_call', 'retell_call', 'sor_upload', 'irs_direct_dial')),
  ADD COLUMN IF NOT EXISTS attributed_entity_ids uuid[],
  ADD COLUMN IF NOT EXISTS auto_closed_reason text,
  ADD COLUMN IF NOT EXISTS source_session_id text,  -- bland_call_id / sor batch id / etc.
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;

-- Backfill existing rows as 'manual' since they were all hand-entered
UPDATE expert_time_logs SET kind = 'manual' WHERE kind IS NULL;

-- Index for the "find this expert's open auto-session" lookup the API needs
-- on every batch-upload + Bland webhook fire.
CREATE INDEX IF NOT EXISTS idx_expert_time_logs_open_session
  ON expert_time_logs (expert_id, kind, end_at)
  WHERE end_at IS NULL;

-- Index for the rolling-window "extend if active in last N min" check
CREATE INDEX IF NOT EXISTS idx_expert_time_logs_last_activity
  ON expert_time_logs (expert_id, last_activity_at DESC)
  WHERE end_at IS NULL;

COMMENT ON COLUMN expert_time_logs.kind IS
  'Activity kind: manual (legacy hand entries), bland_call/retell_call (auto from voice provider), sor_upload (auto from batch-upload bookmarklet activity), irs_direct_dial (expert manually opened a session for a non-Bland call to IRS).';

COMMENT ON COLUMN expert_time_logs.attributed_entity_ids IS
  'Entity IDs this time block contributed to. Lets the daily COGS calc compute true cost-per-completion (sum hours × hourly_rate, divide by completed entities in the same window).';

COMMENT ON COLUMN expert_time_logs.auto_closed_reason IS
  'Why the session auto-closed: idle_timeout (no activity in N min), explicit_stop (user clicked Stop), no_activity_after_start (session opened but no follow-up event), session_max_duration (capped at 4 hr).';

COMMENT ON COLUMN expert_time_logs.source_session_id IS
  'External session ID that triggered this log: irs_call_sessions.id (for bland_call/retell_call), batch upload run identifier (for sor_upload), or null (for manual/irs_direct_dial).';

COMMENT ON COLUMN expert_time_logs.last_activity_at IS
  'Rolling timestamp updated by /api/expert/time-log/event ping. Used by the auto-close cron to decide which sessions to close after IDLE_THRESHOLD_MINUTES of inactivity.';
