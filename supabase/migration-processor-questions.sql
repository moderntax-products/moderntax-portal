-- In-app processor Q&A system.
--
-- Goal: get processor questions off Matt's personal inbox into a tracked
-- channel that (a) gets an instant AI answer for the 80% of questions
-- with known answers, (b) cleanly escalates the 20% novel ones to admin
-- review, (c) builds a corpus of resolved Q&A for future AI training,
-- and (d) audit-tracks every question for SOC 2 disclosure logging.
--
-- Apply via: Supabase Dashboard → SQL Editor → paste + Run.

CREATE TABLE IF NOT EXISTS public.processor_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who asked
  asked_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  asked_by_email TEXT,                              -- denormalized for fast filtering
  client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,

  -- The question + optional context
  question_text TEXT NOT NULL CHECK (char_length(question_text) > 0),
  -- Optional entity context (e.g., "this question is about request entity X")
  context_entity_id UUID REFERENCES public.request_entities(id) ON DELETE SET NULL,
  context_request_id UUID REFERENCES public.requests(id) ON DELETE SET NULL,

  -- AI's answer
  ai_response TEXT,
  ai_model TEXT,                                    -- e.g., 'claude-3-5-sonnet-20241022'
  ai_response_at TIMESTAMPTZ,
  -- Self-reported confidence flag from the prompt — when low, surface
  -- "escalate to admin" CTA prominently. Stored as TEXT so AI can return
  -- 'high'/'medium'/'low' or a numeric confidence.
  ai_confidence TEXT,

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'pending_ai' CHECK (
    status IN (
      'pending_ai',          -- in-flight to AI
      'answered_by_ai',      -- AI returned a response
      'escalated',           -- processor flagged for human review (admin)
      'answered_by_admin',   -- admin replied (after escalation)
      'closed'               -- processor marked answered / left
    )
  ),

  -- Admin escalation
  escalated_at TIMESTAMPTZ,
  escalated_reason TEXT,
  admin_response TEXT,
  admin_response_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  admin_response_at TIMESTAMPTZ,

  -- Processor feedback (for future AI fine-tuning)
  ai_response_helpful BOOLEAN,                      -- thumbs up/down on AI answer

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processor_questions_asked_by_created
  ON public.processor_questions (asked_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_processor_questions_status
  ON public.processor_questions (status)
  WHERE status IN ('escalated', 'answered_by_admin');
CREATE INDEX IF NOT EXISTS idx_processor_questions_client_id
  ON public.processor_questions (client_id);

CREATE OR REPLACE FUNCTION trg_processor_questions_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS processor_questions_updated_at ON public.processor_questions;
CREATE TRIGGER processor_questions_updated_at
  BEFORE UPDATE ON public.processor_questions
  FOR EACH ROW EXECUTE FUNCTION trg_processor_questions_updated_at();

-- RLS — processors see their own questions; admins see all. Per-tenant
-- policy (managers see questions from their client's processors) is a
-- Phase-2 follow-up matching MOD-186.
ALTER TABLE public.processor_questions ENABLE ROW LEVEL SECURITY;
