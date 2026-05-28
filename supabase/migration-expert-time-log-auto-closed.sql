-- expert_time_logs: track auto-closed sessions distinctly from manual closes.
--
-- The expert-stale-session-cleanup cron auto-closes sessions left open
-- >12 hours, capping the duration at 8 hours from clock-in (saner than
-- crediting a 36-hour "shift" because the expert forgot to clock out).
--
-- This flag lets the timesheet UI surface "this session was auto-closed by
-- the system — please confirm or correct hours" so the expert can self-fix
-- before payroll close.

ALTER TABLE public.expert_time_logs
  ADD COLUMN IF NOT EXISTS auto_closed BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN public.expert_time_logs.auto_closed IS
  'TRUE when the session was closed by the expert-stale-session-cleanup cron after exceeding 12h open. Hours are capped at 8h from start_at.';
