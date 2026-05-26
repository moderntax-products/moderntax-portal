-- Entity notes — admin ↔ expert ops thread per request_entity.
--
-- Driver: 2026-05-26 Joel Abernathy feedback — "It would be nice to have
-- notes/comments for each client indicating what info/transcripts are
-- required from the IRS, so I wouldn't have to get those details from
-- you directly." Today admin sends those instructions by email, which
-- means Joel has to dig through Gmail to find what's been asked for any
-- given entity. This puts the conversation on the entity record where
-- it belongs.
--
-- Scope: admin <-> expert internal ops chatter only. Not exposed to
-- processor/manager roles (those are client-facing and don't need to see
-- IRS-call coordination details). Borrower-facing comms remain in
-- existing email + Dropbox Sign channels.

CREATE TABLE IF NOT EXISTS public.entity_notes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id     UUID NOT NULL REFERENCES public.request_entities(id) ON DELETE CASCADE,
  author_id     UUID NOT NULL REFERENCES auth.users(id),
  -- Denormalized author info — the thread keeps reading correctly even
  -- if the author's profile is later renamed/deleted. Frozen at write time.
  author_role   TEXT NOT NULL CHECK (author_role IN ('admin', 'expert')),
  author_name   TEXT NOT NULL,
  body          TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  -- Optional categorization to help the expert scan a long thread
  kind          TEXT NOT NULL DEFAULT 'note'
                CHECK (kind IN ('note', 'instruction', 'status_update', 'question', 'answer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS entity_notes_entity_id_idx ON public.entity_notes(entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS entity_notes_author_idx    ON public.entity_notes(author_id, created_at DESC);

COMMENT ON TABLE public.entity_notes IS
  'Admin <-> expert ops thread per entity. Tracks IRS call instructions, status updates, expert questions, admin answers. Migration-entity-notes.sql 2026-05-26.';
COMMENT ON COLUMN public.entity_notes.author_role IS
  'admin or expert only. Processor/manager threads use a different surface (client-facing).';

-- RLS — service role bypasses; authenticated users must be admin OR the
-- assigned expert of the entity.
ALTER TABLE public.entity_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entity_notes_admin_all ON public.entity_notes;
CREATE POLICY entity_notes_admin_all ON public.entity_notes
  FOR ALL
  USING (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

DROP POLICY IF EXISTS entity_notes_expert_own_assignments ON public.entity_notes;
CREATE POLICY entity_notes_expert_own_assignments ON public.entity_notes
  FOR ALL
  USING (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.expert_assignments a
      WHERE a.entity_id = entity_notes.entity_id
        AND a.expert_id = auth.uid()
        AND a.status IN ('assigned', 'in_progress', 'completed')
    )
  );
