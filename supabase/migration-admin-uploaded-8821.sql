-- Admin-side 8821 upload column — preserves the processor's pre-signed 8821
-- as the source of truth on processor/manager-facing surfaces.
--
-- Driver: 2026-05-28 Matt — "system should never overwrite or replace uploaded
-- 8821 from the processor with other additions from admin. These changes
-- should only be reflected for admins and experts."
--
-- Flow:
--   - First 8821 to land (from any intake — processor CSV bulk, processor
--     PDF intake, processor manual upload via Processor8821Panel, admin
--     upload when no PDF exists yet) goes to signed_8821_url. This is the
--     canonical PDF processors / managers see and the one fax/IRS pipelines
--     consume.
--   - Subsequent admin uploads via Admin8821Upload land here. They never
--     replace signed_8821_url, so the processor's view of "their" 8821
--     remains intact.
--   - Admin + expert UIs surface BOTH columns side-by-side; processor /
--     manager UIs only ever surface signed_8821_url.
--
-- Pattern mirrors expert_regenerated_8821_url, which already lets the
-- post-acceptance designee-correct PDF live alongside the borrower-signed
-- original without overwriting it.

ALTER TABLE public.request_entities
  ADD COLUMN IF NOT EXISTS admin_uploaded_8821_url TEXT;

COMMENT ON COLUMN public.request_entities.admin_uploaded_8821_url IS
  'Admin-supplied 8821 PDF, kept separate from signed_8821_url so the processor''s pre-signed upload is never overwritten. Surface to admins + experts only — never to processors or managers.';
