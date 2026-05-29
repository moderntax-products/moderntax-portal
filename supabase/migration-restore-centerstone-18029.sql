-- One-shot restoration: undo the manual cancellation of Centerstone loan
-- 18029 (Peter Geyen, Great Lakes Wood Co LLC, Peter Geyen Inc — completed
-- May 2026 work).
--
-- Driver: 2026-05-28 Matt — got bounced by the email-intake flow when
-- Soobin's re-pull email forced a fresh CSV with all 3 entities. Matt
-- cancelled the duplicate-looking entry but the cancellation hit the
-- ORIGINAL completed request, not the dup. Reverse it.
--
-- Safety:
--   - SELECTs first so you eyeball the row before flipping it.
--   - Only flips the request row whose status is currently 'cancelled'
--     AND was previously completed (every entity is in a completed-side
--     state). Won't touch the row if those preconditions aren't met.
--   - Idempotent — re-running after restoration is a no-op.
--   - Entities + transcript_urls are untouched; this only fixes the
--     request.status field on the parent.

-- 1. Show me what's there RIGHT NOW so we can sanity-check.
SELECT r.id, r.loan_number, r.status, r.created_at, r.notes,
       (SELECT COUNT(*) FROM public.request_entities re WHERE re.request_id = r.id) AS entity_count,
       (SELECT array_agg(entity_name ORDER BY entity_name) FROM public.request_entities re WHERE re.request_id = r.id) AS entity_names,
       (SELECT array_agg(status) FROM public.request_entities re WHERE re.request_id = r.id) AS entity_statuses
  FROM public.requests r
  JOIN public.clients c ON c.id = r.client_id
 WHERE r.loan_number = '18029'
   AND c.name ILIKE 'Centerstone%'
 ORDER BY r.created_at;

-- 2. Restore. The WHERE clause is deliberately strict: only flip back
--    rows that are currently cancelled AND have every entity in a
--    completed-side state — that's the signature of "this used to be
--    complete and somebody undid it by accident".
UPDATE public.requests AS r
   SET status = 'completed'
  FROM public.clients c
 WHERE r.client_id = c.id
   AND c.name ILIKE 'Centerstone%'
   AND r.loan_number = '18029'
   AND r.status = 'cancelled'
   AND NOT EXISTS (
     SELECT 1 FROM public.request_entities re
      WHERE re.request_id = r.id
        AND re.status NOT IN ('completed', '8821_signed', 'irs_queue', 'processing')
   )
   AND EXISTS (
     -- And there must be at least one completed entity — guards against
     -- restoring an actually-empty cancelled request.
     SELECT 1 FROM public.request_entities re
      WHERE re.request_id = r.id
        AND re.status = 'completed'
   );

-- 3. Verify the flip.
SELECT id, loan_number, status, created_at, notes
  FROM public.requests
 WHERE loan_number = '18029'
   AND client_id IN (SELECT id FROM public.clients WHERE name ILIKE 'Centerstone%')
 ORDER BY created_at;

-- 4. (Optional) If the duplicate "fresh CSV" request you meant to cancel
-- is still hanging around (different request id, same loan_number, also
-- containing Peter Geyen / Great Lakes / Peter Geyen Inc), surface it
-- here so you can cancel THAT one by id afterward. Don't run this
-- automatically — it's purely informational.
SELECT r.id, r.loan_number, r.status, r.created_at, r.notes,
       (SELECT array_agg(entity_name ORDER BY entity_name) FROM public.request_entities re WHERE re.request_id = r.id) AS entity_names
  FROM public.requests r
  JOIN public.clients c ON c.id = r.client_id
 WHERE r.loan_number = '18029'
   AND c.name ILIKE 'Centerstone%'
 ORDER BY r.created_at;
