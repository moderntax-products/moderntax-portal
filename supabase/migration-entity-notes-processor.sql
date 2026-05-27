-- Allow processors + managers to post/read entity notes on entities
-- belonging to their own client. Driver: 2026-05-27 Matt — "We really
-- need this to be dialed in between the request (specifically what is
-- requested by the processor) directly to the expert so there is no
-- admin back and forth natively."
--
-- Original entity_notes RLS only allowed admin + the assigned expert.
-- This extends it so:
--   - Processors can post/read notes on entities belonging to their
--     client_id (regardless of which processor submitted the request)
--   - Same for managers (they oversee their client's processors)
--   - Admin + expert access unchanged
--
-- The author_role check constraint widens to include 'processor' and
-- 'manager' so author identity is preserved in the thread.

ALTER TABLE public.entity_notes
  DROP CONSTRAINT IF EXISTS entity_notes_author_role_check;
ALTER TABLE public.entity_notes
  ADD CONSTRAINT entity_notes_author_role_check
  CHECK (author_role IN ('admin', 'expert', 'processor', 'manager'));

DROP POLICY IF EXISTS entity_notes_processor_own_client ON public.entity_notes;
CREATE POLICY entity_notes_processor_own_client ON public.entity_notes
  FOR ALL
  USING (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM public.profiles p
        JOIN public.request_entities re ON re.id = entity_notes.entity_id
        JOIN public.requests r ON r.id = re.request_id
       WHERE p.id = auth.uid()
         AND p.role IN ('processor', 'manager')
         AND p.client_id = r.client_id
    )
  );

COMMENT ON COLUMN public.entity_notes.author_role IS
  'admin, expert, processor, or manager. Notes are visible to: any admin; the entity''s assigned expert; any processor/manager belonging to the entity''s client.';
