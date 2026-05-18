-- Per-expert 8821 template — let each expert provide their own pre-filled
-- 8821 PDF (with their designee block + Section 3 categories already on it),
-- which the regenerate-8821 flow uses as the canvas and only overlays the
-- taxpayer-specific fields.
--
-- Driver: Joel Abernathy 2026-05-18 — shared his preferred template with
-- broader Section 3 coverage (Income/Employment/Entity across 2015-2028)
-- and "specific use not on CAF" checked. The programmatic generator would
-- produce a different shape, which wouldn't match how Joel wants to handle
-- his IRS calls. Per-expert template = each expert's preferences honored.
--
-- Schema: storage path under the existing `uploads` bucket. Convention:
--   expert-templates/{profile_id}.pdf
--
-- Apply via: Supabase Dashboard → SQL Editor → paste + Run.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS expert_template_8821_url TEXT;

COMMENT ON COLUMN public.profiles.expert_template_8821_url IS
  'Storage path of an optional pre-filled 8821 template specific to this expert. When set, generate8821PDF uses this file as the canvas and only overlays taxpayer fields (Section 1) — designee + Section 3 come from the template. Falls back to programmatic generation when null.';
