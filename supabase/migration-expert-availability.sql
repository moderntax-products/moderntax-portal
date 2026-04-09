-- Expert Availability Commitments
-- Experts commit to specific time slots when they'll be available
-- to take IRS PPS callbacks on their personal phone.

CREATE TABLE IF NOT EXISTS public.expert_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expert_id UUID NOT NULL REFERENCES auth.users(id),

  -- Which day and time window
  available_date DATE NOT NULL,
  start_time TIME NOT NULL,       -- e.g. '09:00'
  end_time TIME NOT NULL,         -- e.g. '11:00'
  timezone TEXT NOT NULL DEFAULT 'America/New_York',

  -- What should happen
  call_mode TEXT NOT NULL DEFAULT 'hold_and_transfer'
    CHECK (call_mode IN ('hold_and_transfer', 'irs_callback', 'ai_full')),
  callback_phone TEXT,            -- override; falls back to profile phone

  -- Which assignments to process (NULL = all pending assignments)
  assignment_ids UUID[],

  -- Processing state
  status TEXT NOT NULL DEFAULT 'committed'
    CHECK (status IN ('committed', 'scheduled', 'completed', 'skipped', 'cancelled')),
  call_session_id UUID,           -- links to irs_call_sessions once scheduled

  -- Metadata
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_expert_avail_date
  ON public.expert_availability(available_date, status);
CREATE INDEX IF NOT EXISTS idx_expert_avail_expert
  ON public.expert_availability(expert_id, available_date);

-- RLS
ALTER TABLE public.expert_availability ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Experts can view own availability"
  ON public.expert_availability FOR SELECT
  USING (auth.uid() = expert_id);

CREATE POLICY "Experts can insert own availability"
  ON public.expert_availability FOR INSERT
  WITH CHECK (auth.uid() = expert_id);

CREATE POLICY "Experts can update own availability"
  ON public.expert_availability FOR UPDATE
  USING (auth.uid() = expert_id);

CREATE POLICY "Service role full access"
  ON public.expert_availability FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');
