-- Add the 'direct_user' role to profiles.role.
--
-- A ModernTax Direct taxpayer (e.g. Marquis Steadman) gets a LIMITED account:
-- they see only their own case (status + resolution roadmap), complete their
-- filing intake, pay the filing fee, and chat with support for confirmation.
-- No team invites, no billing dashboard, no request management — the app
-- redirects them straight to their request and never shows the client
-- dashboard (see app/page.tsx + the role gates in app/api/entity-notes).
--
-- Widen the role CHECK to a superset of the in-use roles plus 'direct_user'.
-- Idempotent: drop + re-add so re-running is safe.

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'expert', 'manager', 'processor', 'assistant', 'user', 'team_member', 'direct_user'));
