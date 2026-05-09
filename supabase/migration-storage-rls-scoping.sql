-- Storage RLS hardening — scope `uploads` bucket access by client_id / expert assignment
--
-- Problem: the original policy in migration-v2.sql allowed ANY authenticated
-- user to read ANY object in the `uploads` bucket:
--
--   bucket_id = 'uploads' AND auth.uid() IS NOT NULL
--
-- That means a Centerstone processor with a valid session could call
-- supabase.storage.from('uploads').download('clearfirm-uuid/8821/whatever.pdf')
-- directly from the browser, bypassing every per-entity authorization
-- check enforced in the API layer. SOC 2 CC6.1 / CC6.7 — high-impact data
-- segregation failure on a multi-tenant service handling SSN/EIN.
--
-- Storage path conventions in this codebase:
--   1. `{client_id}/...`              — CSV uploads, PDF intake, 8821 intake
--   2. `transcripts/{entity_id}/...`  — IRS transcripts uploaded by experts
--   3. `cash-flow-packs/{entity_id}/...` — cash-flow analysis PDFs
--
-- Access rules:
--   - Admin (`profiles.role = 'admin'`) reads/writes everything.
--   - Manager / processor reads/writes objects whose first path segment
--     matches their `profiles.client_id`, OR objects under
--     `transcripts/{entity_id}` / `cash-flow-packs/{entity_id}` where the
--     entity belongs to a request owned by their client.
--   - Expert reads/writes objects under `transcripts/{entity_id}` /
--     `cash-flow-packs/{entity_id}` where they have an `expert_assignments`
--     row for that entity.
--   - Service-role (used by createAdminClient in API routes) bypasses RLS
--     by default — unchanged.
--
-- Idempotent — safe to re-run.

-- ---------------------------------------------------------------------------
-- Helper: does the current `auth.uid()` have access to the given object path?
-- ---------------------------------------------------------------------------
-- A SECURITY DEFINER function so the RLS check can join through profiles /
-- request_entities / requests / expert_assignments without the caller
-- needing direct SELECT on those tables. Returns boolean.
CREATE OR REPLACE FUNCTION public.user_can_access_upload(object_path TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid           UUID := auth.uid();
  user_role     TEXT;
  user_client   UUID;
  first_segment TEXT;
  entity_uuid   UUID;
BEGIN
  -- Anonymous = no access.
  IF uid IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT role, client_id INTO user_role, user_client
  FROM public.profiles
  WHERE id = uid;

  -- Unknown user = no access.
  IF user_role IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Admin sees everything (matches API-layer behavior of createAdminClient).
  IF user_role = 'admin' THEN
    RETURN TRUE;
  END IF;

  -- Extract the first path segment ("client-uuid", "transcripts",
  -- "cash-flow-packs", etc.).
  first_segment := split_part(object_path, '/', 1);

  -- Convention 1 — `{client_id}/...` (CSV/PDF/8821 intake)
  --
  -- Manager + processor get access if the leading UUID matches their
  -- own client_id. Cast through a temp variable so a malformed path
  -- (non-UUID first segment) returns NULL instead of erroring.
  BEGIN
    IF user_role IN ('manager', 'processor', 'team_member')
       AND first_segment::UUID = user_client THEN
      RETURN TRUE;
    END IF;
  EXCEPTION WHEN invalid_text_representation THEN
    -- first_segment wasn't a UUID — fall through to the entity-scoped checks.
    NULL;
  END;

  -- Conventions 2 & 3 — `transcripts/{entity_id}/...` and
  -- `cash-flow-packs/{entity_id}/...`
  IF first_segment IN ('transcripts', 'cash-flow-packs') THEN
    BEGIN
      entity_uuid := split_part(object_path, '/', 2)::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN FALSE;
    END;

    -- Manager / processor: entity must belong to their client.
    IF user_role IN ('manager', 'processor', 'team_member') THEN
      RETURN EXISTS (
        SELECT 1
        FROM public.request_entities re
        JOIN public.requests r ON r.id = re.request_id
        WHERE re.id = entity_uuid
          AND r.client_id = user_client
      );
    END IF;

    -- Expert: must have an active assignment for this entity.
    IF user_role = 'expert' THEN
      RETURN EXISTS (
        SELECT 1
        FROM public.expert_assignments ea
        WHERE ea.expert_id = uid
          AND ea.entity_id = entity_uuid
      );
    END IF;
  END IF;

  -- Default deny.
  RETURN FALSE;
END;
$$;

COMMENT ON FUNCTION public.user_can_access_upload(TEXT) IS
  'Storage RLS authorization helper. Returns TRUE if the current auth.uid() has access to the given object path under the uploads bucket. Used by SELECT / INSERT / UPDATE / DELETE policies on storage.objects.';

-- ---------------------------------------------------------------------------
-- Replace the wide-open policies
-- ---------------------------------------------------------------------------

-- Drop the legacy permissive policies if they exist.
DROP POLICY IF EXISTS "Users can upload files"     ON storage.objects;
DROP POLICY IF EXISTS "Users can read own uploads" ON storage.objects;
-- Defensive: also drop our own names in case this migration was partially
-- applied during a prior run.
DROP POLICY IF EXISTS "uploads_select_scoped" ON storage.objects;
DROP POLICY IF EXISTS "uploads_insert_scoped" ON storage.objects;
DROP POLICY IF EXISTS "uploads_update_scoped" ON storage.objects;
DROP POLICY IF EXISTS "uploads_delete_scoped" ON storage.objects;

CREATE POLICY "uploads_select_scoped" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'uploads'
    AND public.user_can_access_upload(name)
  );

CREATE POLICY "uploads_insert_scoped" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'uploads'
    AND public.user_can_access_upload(name)
  );

CREATE POLICY "uploads_update_scoped" ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'uploads'
    AND public.user_can_access_upload(name)
  )
  WITH CHECK (
    bucket_id = 'uploads'
    AND public.user_can_access_upload(name)
  );

CREATE POLICY "uploads_delete_scoped" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'uploads'
    AND public.user_can_access_upload(name)
  );

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- The helper function needs to be callable by the `authenticated` role so
-- the RLS evaluator can invoke it on every storage.objects read/write.
GRANT EXECUTE ON FUNCTION public.user_can_access_upload(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_access_upload(TEXT) TO service_role;
