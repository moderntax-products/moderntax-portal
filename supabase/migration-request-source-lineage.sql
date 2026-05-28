-- Track the source request a reorder was cloned from. Surfaces on the
-- admin request detail page as a "Reorder of loan X" badge so billing
-- + ops audits can trace the chain in one click.
--
-- Driver: 2026-05-28 Matt — Soobin's Peter Geyen reorder. With the new
-- /admin/email-intake "Reorder from history" mode, every reorder gets
-- a fresh requests row + fresh request_entities row. We want the chain
-- captured in the DB (not just intake_method='admin_reorder') so we
-- can answer "what's the source of this completion?" without grepping
-- notes.
--
-- Pattern matches the existing batch_id column: nullable FK, set only
-- on rows that have a source; NULL on everything else.

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS source_request_id UUID
    REFERENCES public.requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_requests_source_request_id
  ON public.requests(source_request_id)
  WHERE source_request_id IS NOT NULL;

COMMENT ON COLUMN public.requests.source_request_id IS
  'For requests created via admin reorder-from-history, the prior request the entity was cloned from. NULL on first-time intake. Surfaces as a "Reorder of #X" badge on /admin/requests/[id].';
