-- Widen entity_notes.kind to allow customer-service support tickets.
--
-- Repurposes the admin<->expert note channel as a processor<->admin
-- customer-service channel: a processor (e.g. Sonja Lewis, Cal Statewide)
-- raises a "support" note on the entity they're having trouble with
-- ("transcripts ready but only the 8821 downloads"), which routes to the
-- ModernTax customer-service inbox instead of the assigned expert. Admin
-- replies with the same kind, which routes back to the processor.
--
-- The original constraint (migration-entity-notes.sql) only allowed
-- 'note','instruction','status_update','question','answer'. Add 'support'.
-- Idempotent: drop + re-add so re-running is safe.

ALTER TABLE public.entity_notes
  DROP CONSTRAINT IF EXISTS entity_notes_kind_check;

ALTER TABLE public.entity_notes
  ADD CONSTRAINT entity_notes_kind_check
  CHECK (kind IN ('note', 'instruction', 'status_update', 'question', 'answer', 'support'));
