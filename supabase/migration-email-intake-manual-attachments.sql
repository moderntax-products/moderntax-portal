-- Email Intake: support manual-entry orders (no CSV) + multiple attachments.
-- Driver: Enterprise Bank's first trial request 2026-05-20 — they sent a
-- secure email with the loan note + a pre-signed 8821 they had for a
-- different vendor (not us). Need a path to create the order from those
-- attachments alone, without round-tripping a CSV.
--
-- batches.extra_attachment_urls: TEXT[] of storage paths for any
-- supplementary files attached to an intake (loan notes, third-party
-- 8821 references for entity-info extraction, etc.). The primary
-- source_file_url stays as today (CSV or, in manual mode, the most
-- relevant attachment) so existing UI doesn't regress.
--
-- batches.intake_subtype: optional string distinguishing 'csv' (default,
-- unchanged) from 'manual' so admin pages can render the right detail
-- view. NULL = unspecified (existing rows treated as csv).

ALTER TABLE batches
  ADD COLUMN IF NOT EXISTS extra_attachment_urls TEXT[] DEFAULT '{}'::TEXT[];

ALTER TABLE batches
  ADD COLUMN IF NOT EXISTS intake_subtype TEXT;

COMMENT ON COLUMN batches.extra_attachment_urls IS
  'Supplementary attachments (storage paths in uploads bucket) for an intake — e.g., loan notes, third-party 8821 references. Primary file stays at source_file_url.';
COMMENT ON COLUMN batches.intake_subtype IS
  'csv (default) | manual — for admin email-intake UI rendering. NULL = pre-existing rows.';
