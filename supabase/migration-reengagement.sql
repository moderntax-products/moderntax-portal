-- Processor Re-Engagement Sequence — state tracking.
--
-- Two lifecycle tracks nudge processors with a ModernTax seat who aren't
-- ordering: Track A (never activated) and Track B (lapsed). Track/step are
-- DERIVED from order history + dates at runtime; this table only records what
-- was already SENT so the cron advances the cadence and never repeats a step,
-- and so the manager-loop can be throttled (one per lender per 30 days).
--
-- Apply in Supabase Studio (no programmatic DDL available).

-- 1. Per-user opt-out — set when a processor asks to pause, or an admin opts
--    the seat out. The cron skips anyone with nudges_paused = true.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS nudges_paused boolean NOT NULL DEFAULT false;

-- 2. Send log — one row per re-engagement email sent (or shadow-logged).
CREATE TABLE IF NOT EXISTS public.reengagement_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,  -- NULL for account-level manager-loop
  client_id uuid REFERENCES public.clients(id) ON DELETE CASCADE,
  track text NOT NULL,            -- 'A' | 'B'
  step text NOT NULL,             -- 'A1'..'A4', 'B1'..'B4'
  recipient_email text,
  shadow boolean NOT NULL DEFAULT false,  -- true = dry-run (nothing actually sent)
  sent_at timestamptz NOT NULL DEFAULT now()
);

-- Look up "has this user already received this step?" and "when did this
-- account last get a manager-loop email?" quickly.
CREATE INDEX IF NOT EXISTS reengagement_log_user_step_idx
  ON public.reengagement_log (user_id, step);
CREATE INDEX IF NOT EXISTS reengagement_log_client_step_idx
  ON public.reengagement_log (client_id, step, sent_at DESC);

-- 3. Lock the table down. Only the cron touches it, via the service-role key
--    (which BYPASSES RLS), so enabling RLS with NO policies blocks all
--    anon/authenticated access while the cron keeps working unchanged.
ALTER TABLE public.reengagement_log ENABLE ROW LEVEL SECURITY;
