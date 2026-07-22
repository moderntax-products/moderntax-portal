-- Per-manager opt-out for operational notifications (2026-07-22)
--
-- The "Entity Transcript Add-On ordered" email fans out to EVERY manager on a
-- client (upload/pdf, upload/csv, notify/entity-transcript all query
-- role='manager' with no suppression). Zeinab Ahmad (Assistant Controller,
-- Cal Statewide) asked to be removed — she's a manager but doesn't want the
-- per-order operational noise, while other managers on the same client may.
--
-- This is a per-PERSON preference, not per-client, so it lives on profiles.
-- Distinct from nudges_paused (that gates MARKETING lifecycle emails); these
-- are transactional operational notifications, so they get their own flag.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS manager_notifications_paused BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN profiles.manager_notifications_paused IS
  'Manager opted out of per-order operational notifications (entity-transcript add-on, etc.). Distinct from nudges_paused (marketing lifecycle). Default FALSE = still notified.';
