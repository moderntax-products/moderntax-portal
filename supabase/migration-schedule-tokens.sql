-- Expert Schedule Tokens
-- Daily tokens sent via email for experts to opt in to IRS call time slots

CREATE TABLE IF NOT EXISTS public.expert_schedule_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expert_id UUID NOT NULL REFERENCES auth.users(id),
  token TEXT NOT NULL UNIQUE,
  schedule_date DATE NOT NULL,

  -- Confirmation
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'expired', 'skipped')),
  confirmed_time TEXT,          -- e.g. '09:00'
  confirmed_mode TEXT,          -- 'hold_and_transfer' | 'irs_callback'
  call_session_id UUID,         -- links to irs_call_sessions
  confirmed_at TIMESTAMPTZ,

  -- Metadata
  entity_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schedule_tokens_token
  ON public.expert_schedule_tokens(token);
CREATE INDEX IF NOT EXISTS idx_schedule_tokens_date
  ON public.expert_schedule_tokens(schedule_date, status);
CREATE INDEX IF NOT EXISTS idx_schedule_tokens_expert
  ON public.expert_schedule_tokens(expert_id, schedule_date);
