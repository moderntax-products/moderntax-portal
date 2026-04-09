-- Expert Callback / Call Transfer Fields
-- Adds support for routing live IRS agents to the expert's personal phone

ALTER TABLE public.irs_call_sessions
  ADD COLUMN IF NOT EXISTS callback_phone TEXT,            -- expert's personal phone to transfer to
  ADD COLUMN IF NOT EXISTS callback_mode TEXT DEFAULT 'transfer'
    CHECK (callback_mode IN ('transfer', 'irs_callback')),  -- transfer = warm transfer when agent answers; irs_callback = accept IRS callback option
  ADD COLUMN IF NOT EXISTS callback_status TEXT
    CHECK (callback_status IN ('waiting', 'transferring', 'connected', 'failed', 'voicemail', 'no_answer')),
  ADD COLUMN IF NOT EXISTS callback_initiated_at TIMESTAMPTZ,  -- when transfer/callback was initiated
  ADD COLUMN IF NOT EXISTS callback_connected_at TIMESTAMPTZ,  -- when expert actually connected
  ADD COLUMN IF NOT EXISTS hold_start_at TIMESTAMPTZ,          -- when hold began (for live hold timer)
  ADD COLUMN IF NOT EXISTS agent_answered_at TIMESTAMPTZ;      -- when IRS agent picked up

-- Index for finding calls awaiting transfer
CREATE INDEX IF NOT EXISTS idx_irs_calls_callback_status
  ON public.irs_call_sessions(callback_status)
  WHERE callback_status IS NOT NULL;
