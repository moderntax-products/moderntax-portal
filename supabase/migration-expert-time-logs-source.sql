-- Expert time tracking — source attribution + idempotency
--
-- Until now, expert_time_logs was a manual-only table: expert taps start/stop
-- on the dashboard, hours_worked is computed, done. Problem: experts forget
-- to clock in/out. 2026-05-21 daily summary showed only 1.4h logged when the
-- iCloud expert had spent 5.6h on PPS calls + SOR bookmarklet sessions.
--
-- This migration adds:
--   - `source`     — where the entry came from. Default 'manual' so existing
--                    rows behave identically. New automated rows are tagged
--                    with their derivation source.
--   - `source_id`  — pointer back to the source row (or composite key for
--                    derived clusters). Nullable for manual entries.
--   - Unique partial index on (expert_id, source, source_id) so the
--     materializer can use ON CONFLICT DO NOTHING for idempotent reruns.
--
-- Source enumeration:
--   manual              — operator clocked in/out via dashboard (legacy)
--   irs_call            — derived from irs_call_sessions (Bland/Retell calls)
--   bookmarklet_session — derived from request_entities.transcript_urls upload
--                         timestamp clustering (storage paths carry Date.now())
--   callback_tap        — operator pressed "I'm on a callback now" in the
--                         dashboard widget (future Layer 3)

ALTER TABLE expert_time_logs
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_id TEXT;

-- Partial unique index — only enforces uniqueness for non-manual rows where
-- source_id is set. Manual entries (source_id IS NULL) can coexist freely so
-- legacy data + future manual entries aren't disturbed.
CREATE UNIQUE INDEX IF NOT EXISTS expert_time_logs_source_unique
  ON expert_time_logs (expert_id, source, source_id)
  WHERE source_id IS NOT NULL;

COMMENT ON COLUMN expert_time_logs.source IS
  'Where the entry came from: manual | irs_call | bookmarklet_session | callback_tap';

COMMENT ON COLUMN expert_time_logs.source_id IS
  'Pointer back to source row (irs_call_sessions.id, or composite "entity_id|cluster_start_ts" for bookmarklet sessions). NULL for manual entries.';
