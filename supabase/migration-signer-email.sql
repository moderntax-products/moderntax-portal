-- Migration: Add signer_email to request_entities for Dropbox Sign integration
-- Required for auto-sending 8821 forms via HelloSign API

ALTER TABLE public.request_entities
  ADD COLUMN IF NOT EXISTS signer_email TEXT DEFAULT NULL;
