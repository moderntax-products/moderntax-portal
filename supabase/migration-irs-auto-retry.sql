-- IRS PPS auto-redial — MVP scope (MOD-211)
--
-- When an IRS PPS call ends with the "extremely high call volume" rejection,
-- the system automatically initiates a new call from a different phone-pool
-- number, preserving the chain so the expert sees one logical effort
-- instead of N manual restarts.
--
-- Phase 1 / MVP: schema + classifier + webhook trigger only. UI surface,
-- AI prompt update for callback-preference, and per-expert daily caps land
-- in subsequent phases per MOD-211.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.irs_call_sessions
  ADD COLUMN IF NOT EXISTS parent_session_id     UUID REFERENCES public.irs_call_sessions(id),
  ADD COLUMN IF NOT EXISTS retry_count           INT  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_retries           INT  DEFAULT 30,
  ADD COLUMN IF NOT EXISTS retry_reason          TEXT,
  ADD COLUMN IF NOT EXISTS auto_retry_enabled    BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS retry_terminal_state  TEXT,
  ADD COLUMN IF NOT EXISTS from_number           TEXT,
  ADD COLUMN IF NOT EXISTS classified_outcome    TEXT;

COMMENT ON COLUMN public.irs_call_sessions.parent_session_id IS
  'Links a retry attempt to the original session in the same chain. Null = root attempt.';
COMMENT ON COLUMN public.irs_call_sessions.retry_count IS
  '0 for root attempts; 1, 2, … for each subsequent retry. Capped at max_retries.';
COMMENT ON COLUMN public.irs_call_sessions.retry_reason IS
  'Why this session was retried (filled on the parent when a retry fires). One of: high_volume_rejected | connection_failed.';
COMMENT ON COLUMN public.irs_call_sessions.retry_terminal_state IS
  'Final state of the retry chain. One of: agent_reached | callback_scheduled | cap_hit | cancelled. Null while chain is still active.';
COMMENT ON COLUMN public.irs_call_sessions.from_number IS
  'The pool phone number used for this attempt. Used to rotate to a different number on retry.';
COMMENT ON COLUMN public.irs_call_sessions.classified_outcome IS
  'Result of lib/irs-call-classifier.classifyCallOutcome on the transcript. One of: high_volume_rejected | callback_scheduled | agent_reached | connection_failed | other.';

-- Index for the safety-net cron (Phase 2): find sessions that ended with
-- a retry-eligible outcome but didn't fire a follow-up call.
CREATE INDEX IF NOT EXISTS idx_irs_call_sessions_pending_retry
  ON public.irs_call_sessions(ended_at)
  WHERE auto_retry_enabled = TRUE
    AND retry_terminal_state IS NULL
    AND classified_outcome = 'high_volume_rejected';

-- Index for "find me the chain rooted at this session" queries used by
-- the retry coordinator to gather the exclusion list of from_numbers.
CREATE INDEX IF NOT EXISTS idx_irs_call_sessions_parent_session
  ON public.irs_call_sessions(parent_session_id)
  WHERE parent_session_id IS NOT NULL;
