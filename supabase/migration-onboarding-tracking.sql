-- Onboarding tour completion tracking
--
-- Processors land on the dashboard for the first time and see a "Take
-- the 5-minute tour" banner. The /onboarding page walks them through
-- every feature with click-through steps. When they finish (or
-- explicitly dismiss), this column gets a timestamp and the banner
-- doesn't show again.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_dismissed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.profiles.onboarding_completed_at IS
  'When the user clicked through the entire /onboarding tour. Hides the dashboard banner.';
COMMENT ON COLUMN public.profiles.onboarding_dismissed_at IS
  'When the user explicitly dismissed the tour without completing it. Also hides the banner; tour remains accessible via Help link.';
