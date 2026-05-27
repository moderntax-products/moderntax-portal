-- Per-client billing toggles to strip $10 self-signed 8821 surcharge
-- and monitoring entirely. Driver: 2026-05-27 Matt + Mathew Paek call —
-- Centerstone is going back to flat-rate-only ($59.98/verification),
-- uploading their own pre-signed 8821s and skipping monitoring entirely.
--
-- Both toggles default FALSE so other clients keep current behavior.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS disable_8821_surcharge BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS disable_monitoring     BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.clients.disable_8821_surcharge IS
  'When TRUE: auto-invoice + breakdown skip the $10 self-signed 8821 surcharge for this client. Use when client is uploading pre-signed 8821s themselves (Centerstone-style flat-rate-only contract).';
COMMENT ON COLUMN public.clients.disable_monitoring IS
  'When TRUE: monitoring lines stripped from invoice + breakdown, monitoring UI surfaces hidden from processor portal for this client, and any re-pulls require a fresh full-price request rather than recurring monitoring enrollment.';

-- Centerstone: both ON per the 5/27 contract clarification.
UPDATE public.clients
  SET disable_8821_surcharge = TRUE,
      disable_monitoring     = TRUE
WHERE name = 'Centerstone SBA Lending';
