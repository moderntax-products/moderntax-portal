-- Cal Statewide instruction template — captured 2026-05-28 from Sonja Lewis.
--
-- Sonja: "we will always request three years, and those years depend on the
-- tax returns that we received. We have been seeing a lot of 2025 tax returns
-- so we would order 2023-2025. If we do not have the 2025 tax return, we will
-- order 2022-2024."
--
-- The {years} placeholder is substituted by lib/intake-note-autopost.ts at
-- intake time with whatever years the processor entered on the row. The body
-- below explains the anchoring rule so the expert can sanity-check the year
-- range against the latest filed return Sonja's team has in their LOS.
--
-- We set "default" so it applies to any form_type Cal Statewide ever sends
-- (today: 1040; tomorrow: any). The per-form override slot stays open for
-- future tweaks (e.g. 1120 for a corp-anchored entity).
--
-- jsonb merge (||) preserves any existing keys on the column and overrides
-- only the "default" slot — safe to re-run.

UPDATE public.clients
   SET entity_instruction_templates =
         COALESCE(entity_instruction_templates, '{}'::jsonb)
         || jsonb_build_object('default', $$Pull ROA + Tax Return Transcripts for {years}.

Cal Statewide always requests a 3-year window anchored on the most recent return on file:
  • 2025 return on file → 2023, 2024, 2025
  • 2025 not on file → 2022, 2023, 2024

The years above were chosen at intake based on which TR was the latest in Sonja's LOS. If the years here don't span 3 consecutive years anchored on the latest filed return, flag it via Notes before pulling — Sonja's team can confirm or correct.$$)
 WHERE name ILIKE 'Cal Statewide%';

-- Sanity check — surfaces the new value so you can eyeball it in psql/Studio.
SELECT name, entity_instruction_templates -> 'default' AS default_template
  FROM public.clients
 WHERE name ILIKE 'Cal Statewide%';
