-- Per-client entity-instruction templates. Surfaces in the
-- <EntityNotesThread> as "📋 Apply [Client] default" — pre-fills the
-- post-a-note body so admin doesn't have to retype the same standard
-- request for every entity from the same lender.
--
-- Driver: 2026-05-26 Matt feedback after shipping entity_notes —
-- "Centerstone SBA requests ROA/Tax Return/Civil Penalties for most
-- orders." Lender request patterns are stable per client; templating
-- them turns 4-line manual entries into a 1-click apply + small edits.
--
-- Storage shape: JSONB map keyed by form_type, with a "default"
-- fallback. Examples:
--   { "1120S": "ROA + Tax Return + Civil Penalties on 1120S...",
--     "1040":  "ROA + Tax Return + Wage & Income on 1040...",
--     "default": "ROA + Tax Return + Civil Penalties..." }
--
-- API: /api/entity-notes/[entityId]/template returns the right template
-- for the entity's (client_id, form_type) tuple, falling back to "default"
-- if no form-specific template exists.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS entity_instruction_templates JSONB
    DEFAULT '{}'::JSONB NOT NULL;

COMMENT ON COLUMN public.clients.entity_instruction_templates IS
  'Per-client default instruction templates for admin->expert notes, keyed by entity.form_type with a "default" fallback. Surfaced as one-click templates in the EntityNotesThread admin UI.';

-- Seed Centerstone SBA Lending with their standard ask patterns.
-- Per Matt 2026-05-26: "Centerstone SBA requests ROA/Tax Return/Civil
-- Penalties for most orders." Variants per form type based on observed
-- May 2026 traffic + the Joel 2026-05-26 instruction thread.
UPDATE public.clients
SET entity_instruction_templates = '{
  "default": "ROA + Tax Return Transcript for years {years}.\n\nCivil Penalties + Unfiled Returns compliance check on entity.\n\nConfirm filing status with IRS rep before requesting transcripts if borrower''s form type is uncertain.",

  "1120S": "ROA + Tax Return Transcript on 1120S for years {years}.\n\nIf borrower had quarterly 941 payroll filings, also request Account Transcripts for 941 Q1-Q4 of the most recent year.\n\nCivil Penalties + Unfiled Returns compliance check on entity.",

  "1120": "ROA + Tax Return Transcript on 1120 for years {years}.\n\nIf borrower had quarterly 941 payroll filings, also request Account Transcripts for 941 Q1-Q4 of the most recent year.\n\nCivil Penalties + Unfiled Returns compliance check on entity.\n\nNote: If borrower is actually an S-Corp election (1120S), confirm with IRS rep and switch to 1120S transcripts.",

  "1065": "ROA + Tax Return Transcript on 1065 for years {years}.\n\nIf borrower had quarterly 941 payroll filings, also request Account Transcripts for 941 Q1-Q4 of the most recent year.\n\nCivil Penalties + Unfiled Returns compliance check on entity.",

  "1040": "ROA + Tax Return Transcript + Wage & Income Transcript on 1040 for years {years}.\n\nCivil Penalties + Unfiled Returns compliance check on individual."
}'::JSONB
WHERE name = 'Centerstone SBA Lending';

-- Seed California Statewide CDC with similar patterns (same SBA-lender
-- profile, mostly 1120S/1040 mix).
UPDATE public.clients
SET entity_instruction_templates = '{
  "default": "ROA + Tax Return Transcript for years {years}.\n\nCivil Penalties + Unfiled Returns compliance check on entity.",

  "1120S": "ROA + Tax Return Transcript on 1120S for years {years}.\n\nCivil Penalties + Unfiled Returns compliance check on entity.",

  "1040": "ROA + Tax Return Transcript + Wage & Income on 1040 for years {years}.\n\nCivil Penalties + Unfiled Returns compliance check on individual."
}'::JSONB
WHERE name = 'California Statewide CDC';
