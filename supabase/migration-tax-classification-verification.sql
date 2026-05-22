-- Tax Classification Verification — schema additions for the 2553 + form-mismatch detection.
--
-- Driver: Derek Le @ Enterprise Bank, 2026-05-22. Borrower K.O.K. Trucking
-- filed Form 2553 retroactively for 2024 FY but IRS hadn't processed the
-- S-Corp election yet → 2024 transcripts came back as "1120 Series" stubs
-- instead of 1120S. Productizing the detection + 2553 status pull.
--
-- New columns on request_entities:
--   tax_classification_check_requested boolean
--     = enabled at intake (or auto-enabled for SBA-lender clients). When
--       true, the PPS call adds the 2553 election status to the ask-list.
--   form_2553_status jsonb
--     = { received_date, effective_date, processing_status, raw_notes }
--       Populated from the PPS call, NULL until the agent looks it up.
--   tax_classification_mismatch jsonb
--     = { detected_at, declared_form, irs_form, source, severity, message }
--       Populated by lib/tax-classification.detectTaxClassificationMismatch()
--       after every transcript landing. Persisted (not just computed) so
--       the admin panel can render without re-running detection.

ALTER TABLE request_entities
  ADD COLUMN IF NOT EXISTS tax_classification_check_requested boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS form_2553_status jsonb,
  ADD COLUMN IF NOT EXISTS tax_classification_mismatch jsonb;

-- Index for the admin queue view (find entities flagged with a mismatch)
CREATE INDEX IF NOT EXISTS idx_request_entities_tax_class_mismatch
  ON request_entities ((tax_classification_mismatch->>'detected_at'))
  WHERE tax_classification_mismatch IS NOT NULL;

COMMENT ON COLUMN request_entities.tax_classification_check_requested IS
  'When true, the PPS call agent asks the IRS specialty line to look up the entity''s Form 2553 election status in addition to the standard transcripts. Defaults false; set to true at intake for clients in the SBA vertical or when the lender hints that the borrower has filed 2553.';

COMMENT ON COLUMN request_entities.form_2553_status IS
  'JSON capture of the IRS-side 2553 election status. Shape: { received_date: "YYYY-MM-DD"|null, effective_date: "YYYY-MM-DD"|null, processing_status: "pending"|"accepted"|"rejected"|"not_on_file"|null, raw_notes: string }. NULL until a PPS agent looks it up.';

COMMENT ON COLUMN request_entities.tax_classification_mismatch IS
  'JSON capture of any detected mismatch between borrower-declared form, IRS-of-record filing requirement (BMF Entity), and 2553 election status. Shape: { detected_at: ISO-8601, declared_form: string, irs_form: string|null, source: "bmf_entity"|"transcript_stub"|"2553_lag", severity: "WARNING"|"CRITICAL", message: string, suggested_borrower_action: string }.';
