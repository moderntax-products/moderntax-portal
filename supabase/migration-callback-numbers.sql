-- Autonomous IRS callback handler — number pool + session state machine.
--
-- IRS PPS calls the EXACT number we provide during the call, and texts it ~10
-- min before. To have the AI answer (vs a human), we assign a dedicated, AI-
-- answerable DID (Twilio, voice + SMS) per pending callback; the agent enters
-- that number; IRS texts/calls it; we map the inbound back to its session.
--
-- Constraint: up to 5 simultaneous callbacks per expert (practitioner SSN/CAF).
--
-- Apply in Supabase Studio. Idempotent.

CREATE TABLE IF NOT EXISTS public.callback_numbers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number  text NOT NULL UNIQUE,                 -- E.164, e.g. +13045551234
  provider      text NOT NULL DEFAULT 'twilio',
  voice_enabled boolean NOT NULL DEFAULT true,
  sms_enabled   boolean NOT NULL DEFAULT true,
  status        text NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available', 'assigned', 'disabled')),
  assigned_session_id uuid REFERENCES public.irs_call_sessions(id) ON DELETE SET NULL,
  assigned_expert_id  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS callback_numbers_status_idx ON public.callback_numbers (status);
CREATE INDEX IF NOT EXISTS callback_numbers_expert_idx
  ON public.callback_numbers (assigned_expert_id) WHERE status = 'assigned';

COMMENT ON TABLE public.callback_numbers IS 'Pool of AI-answerable DIDs (voice+SMS) assigned per pending IRS callback. ≤5 active per expert.';

-- Per-session callback state machine.
ALTER TABLE public.irs_call_sessions
  ADD COLUMN IF NOT EXISTS callback_number_id       uuid REFERENCES public.callback_numbers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS callback_sms_received_at  timestamptz,
  ADD COLUMN IF NOT EXISTS callback_state            text NOT NULL DEFAULT 'none'
                            CHECK (callback_state IN ('none', 'waiting', 'imminent', 'answered', 'completed', 'missed'));

COMMENT ON COLUMN public.irs_call_sessions.callback_state IS
  'none → waiting (callback taken, number assigned) → imminent (IRS texted ~10m warning) → answered/completed | missed (no inbound in window → retry).';
