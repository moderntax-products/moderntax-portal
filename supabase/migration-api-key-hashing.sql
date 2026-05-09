-- Partner API key hashing — stop storing keys in plaintext
--
-- Problem: `clients.api_key` stores the partner's `x-api-key` value in
-- plaintext, and the three intake routes look up the client by direct
-- equality on that column:
--
--   .from('clients').select(...).eq('api_key', apiKey).single()
--
-- A DB read = full key compromise; the comparison is also not constant-
-- time (Postgres index probe vs. row scan can leak hint bits). SOC 2
-- CC6.1 expects authenticators to be stored as one-way hashes.
--
-- Approach:
--   1. Add `api_key_hash TEXT` column (SHA-256 hex digest of the key).
--   2. Backfill: hash the existing plaintext value for every client that
--      has one. Lazy-migration would also work but eager backfill avoids
--      the first-hit failure-mode and lets us flip the verification path
--      atomically.
--   3. App code now looks up by `api_key_hash` (computed from incoming
--      header via lib/auth-util.sha256Hex) and constant-time compares.
--   4. Plaintext `api_key` column is RETAINED for now so the admin UI can
--      still display "your current key" if needed AND so a rollback is
--      possible. A follow-up migration will drop it once the UI shifts to
--      "show key once on rotation, never again."
--
-- Idempotent — safe to re-run.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS api_key_hash TEXT;

COMMENT ON COLUMN public.clients.api_key_hash IS
  'SHA-256 hex digest of the partner x-api-key. Validation path uses this column with constant-time comparison; the plaintext api_key column is being phased out.';

-- Unique index so lookups are O(log n) and accidental duplicate keys are
-- caught at write time. Partial because legacy clients with no key set
-- shouldn''t collide on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS clients_api_key_hash_unique
  ON public.clients (api_key_hash)
  WHERE api_key_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Backfill — hash every existing plaintext key
-- ---------------------------------------------------------------------------
-- pgcrypto provides digest(); already enabled by Supabase but ensure it.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

UPDATE public.clients
SET api_key_hash = encode(digest(api_key, 'sha256'), 'hex')
WHERE api_key IS NOT NULL
  AND api_key <> ''
  AND api_key_hash IS NULL;

-- ---------------------------------------------------------------------------
-- Trigger — keep hash in sync if api_key is rotated via SQL/admin tool
-- ---------------------------------------------------------------------------
-- This is a belt-and-suspenders measure for the transition period. App
-- code that creates/rotates keys SHOULD compute the hash itself and
-- write both columns explicitly, but if anyone forgets (or rotates via
-- the Supabase dashboard), the trigger guarantees the hash stays
-- consistent.
CREATE OR REPLACE FUNCTION public.clients_sync_api_key_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.api_key IS NOT NULL AND NEW.api_key <> '' THEN
    NEW.api_key_hash := encode(digest(NEW.api_key, 'sha256'), 'hex');
  ELSIF NEW.api_key IS NULL OR NEW.api_key = '' THEN
    NEW.api_key_hash := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clients_sync_api_key_hash_trg ON public.clients;
CREATE TRIGGER clients_sync_api_key_hash_trg
  BEFORE INSERT OR UPDATE OF api_key ON public.clients
  FOR EACH ROW
  EXECUTE FUNCTION public.clients_sync_api_key_hash();

COMMENT ON FUNCTION public.clients_sync_api_key_hash() IS
  'Trigger function: keeps clients.api_key_hash in sync with clients.api_key during the plaintext-deprecation transition. Will be removed once api_key is dropped.';
