-- Centerstone SBA Lending instruction template — refreshed 2026-05-28 from
-- Matt. Clarifies the standard ask (ROA + TR transcripts for the form on the
-- intake), pulls 941 OUT of the default scope, and flags the conditional 941
-- quarterly Account Transcript pull when the borrower has 941 filings.
--
-- Background:
--   - Centerstone is flat-rate-only now (no 8821 surcharge, no monitoring).
--     The expert SLA assumes ROA + Tax Return Transcripts for the form on the
--     intake, plus the two compliance checks below.
--   - 941 has been getting pulled inconsistently. Matt's directive: 941 is
--     NOT default scope. Only pull 941 Account Transcripts when the borrower
--     actually has quarterly 941 filings on record, and then only for Q1-Q4
--     of the most recent year (not multi-year).
--   - Compliance check on every entity: Civil Penalties + Unfiled Returns.
--
-- The {years} placeholder is substituted by lib/intake-note-autopost.ts at
-- intake with whatever years the processor entered. The form + years lines
-- above the template body in the auto-posted note already show the specific
-- form for this entity, so the template just references "the form above".
--
-- jsonb merge (||) preserves any existing keys on the column and overrides
-- only the "default" slot — safe to re-run.

UPDATE public.clients
   SET entity_instruction_templates =
         COALESCE(entity_instruction_templates, '{}'::jsonb)
         || jsonb_build_object('default', $$Pull ROA + Tax Return Transcripts for the form + years above.

Example: ROA + Tax Return Transcript on 1065 for years 2024-2025.

Centerstone scope:
  • Standard ask: up to 3 years of ROA + Tax Return Transcripts.
  • 941 is NOT in the standard scope.
  • If the borrower has quarterly 941 payroll filings on record → ALSO pull Account Transcripts for 941 Q1-Q4 of the most recent year.
  • Compliance check on this entity: Civil Penalties + Unfiled Returns.$$)
 WHERE name ILIKE 'Centerstone%';

-- Sanity check — surfaces the new value so you can eyeball it in psql/Studio.
SELECT name, entity_instruction_templates -> 'default' AS default_template
  FROM public.clients
 WHERE name ILIKE 'Centerstone%';
