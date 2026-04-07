-- IRS PPS Automated Calling System (Bland AI)
-- Creates tables for tracking IRS call sessions and per-entity outcomes

-- Table 1: irs_call_sessions — One row per IRS phone call (can cover multiple entities)
CREATE TABLE IF NOT EXISTS public.irs_call_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  expert_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- Bland AI
  bland_call_id TEXT,

  -- Call lifecycle
  status TEXT NOT NULL DEFAULT 'initiating' CHECK (
    status IN ('scheduled','initiating','ringing','navigating_ivr','on_hold',
               'speaking_to_agent','completed','failed','cancelled')
  ),

  -- Scheduling (expert picks a time, cron fires the call)
  scheduled_for TIMESTAMPTZ,           -- When to place the call (NULL = immediate)
  scheduled_timezone TEXT DEFAULT 'America/Los_Angeles',

  -- Expert persona used
  caf_number TEXT NOT NULL,
  expert_name TEXT NOT NULL,
  expert_fax TEXT,
  expert_sor_id TEXT,

  -- IRS agent info (extracted from transcript)
  irs_agent_name TEXT,
  irs_agent_badge TEXT,

  -- Timestamps
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  connected_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  hold_duration_seconds INTEGER,

  -- Recording & transcript
  recording_url TEXT,
  recording_storage_path TEXT,
  transcript_json JSONB,
  concatenated_transcript TEXT,
  call_summary TEXT,

  -- Cost
  cost_per_minute NUMERIC(6,4) DEFAULT 0.09,
  estimated_cost NUMERIC(8,2),

  -- Error tracking
  error_message TEXT,

  -- Coaching metadata
  coaching_tags TEXT[],
  coaching_notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Table 2: irs_call_entities — Per-entity outcome within a call (1 call → N entities)
CREATE TABLE IF NOT EXISTS public.irs_call_entities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_session_id UUID NOT NULL REFERENCES public.irs_call_sessions(id) ON DELETE CASCADE,
  assignment_id UUID NOT NULL REFERENCES public.expert_assignments(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES public.request_entities(id) ON DELETE CASCADE,

  -- Entity data sent to IRS
  taxpayer_tid TEXT NOT NULL,
  taxpayer_name TEXT NOT NULL,
  form_type TEXT NOT NULL,
  tax_years TEXT[] NOT NULL,

  -- Per-entity outcome
  outcome TEXT CHECK (
    outcome IN ('transcripts_requested','transcripts_verbal',
                'caf_not_on_file','no_8821_on_file','8821_esig_rejected',
                'name_mismatch','taxpayer_not_found',
                'fax_sent','pending_callback','skipped','other')
  ),
  outcome_notes TEXT,
  fax_sent BOOLEAN DEFAULT FALSE,
  fax_number_used TEXT,

  -- Transcript segment (which part of the call covered this entity)
  transcript_start_index INTEGER,
  transcript_end_index INTEGER,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_irs_calls_expert ON public.irs_call_sessions(expert_id);
CREATE INDEX IF NOT EXISTS idx_irs_calls_bland ON public.irs_call_sessions(bland_call_id);
CREATE INDEX IF NOT EXISTS idx_irs_calls_status ON public.irs_call_sessions(status);
CREATE INDEX IF NOT EXISTS idx_irs_calls_initiated ON public.irs_call_sessions(initiated_at DESC);
CREATE INDEX IF NOT EXISTS idx_irs_calls_scheduled ON public.irs_call_sessions(scheduled_for) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_irs_call_entities_session ON public.irs_call_entities(call_session_id);
CREATE INDEX IF NOT EXISTS idx_irs_call_entities_assignment ON public.irs_call_entities(assignment_id);
CREATE INDEX IF NOT EXISTS idx_irs_call_entities_entity ON public.irs_call_entities(entity_id);

-- RLS
ALTER TABLE public.irs_call_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.irs_call_entities ENABLE ROW LEVEL SECURITY;

-- Experts can read own call sessions
CREATE POLICY "experts_read_own_calls"
  ON public.irs_call_sessions
  FOR SELECT USING (expert_id = auth.uid());

-- Admins can read all call sessions
CREATE POLICY "admins_read_all_calls"
  ON public.irs_call_sessions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Admins can manage all call sessions
CREATE POLICY "admins_manage_calls"
  ON public.irs_call_sessions
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Experts can read own call entities (via session join)
CREATE POLICY "experts_read_own_call_entities"
  ON public.irs_call_entities
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.irs_call_sessions
      WHERE id = call_session_id AND expert_id = auth.uid()
    )
  );

-- Admins can read/manage all call entities
CREATE POLICY "admins_manage_call_entities"
  ON public.irs_call_entities
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Add expert SOR ID to profiles (used for IRS SOR inbox identification)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS sor_id TEXT;
