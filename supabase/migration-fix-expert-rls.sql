-- ============================================================
-- Fix: Expert RLS infinite recursion
--
-- Problem: The RLS policy on request_entities references
-- expert_assignments, which has a FK to request_entities,
-- causing infinite recursion on join queries.
--
-- Solution: Use SECURITY DEFINER functions to break the cycle.
-- These functions run as the DB owner, bypassing RLS on the
-- inner query while still checking auth.uid().
-- ============================================================

-- 1. Create helper function to check expert entity access
CREATE OR REPLACE FUNCTION public.expert_has_assignment(entity_uuid UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM expert_assignments
    WHERE entity_id = entity_uuid
    AND expert_id = auth.uid()
  );
$$;

-- 2. Create helper function to check expert request access
CREATE OR REPLACE FUNCTION public.expert_has_request(request_uuid UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM expert_assignments ea
    JOIN request_entities re ON re.id = ea.entity_id
    WHERE re.request_id = request_uuid
    AND ea.expert_id = auth.uid()
  );
$$;

-- 3. Drop the broken policies
DROP POLICY IF EXISTS "Experts can read assigned entities" ON public.request_entities;
DROP POLICY IF EXISTS "Experts can update assigned entities" ON public.request_entities;
DROP POLICY IF EXISTS "Experts can read requests with assigned entities" ON public.requests;

-- 4. Recreate policies using the SECURITY DEFINER functions
CREATE POLICY "Experts can read assigned entities"
  ON public.request_entities
  FOR SELECT USING (
    public.get_my_role() = 'expert' AND
    public.expert_has_assignment(id)
  );

CREATE POLICY "Experts can update assigned entities"
  ON public.request_entities
  FOR UPDATE USING (
    public.get_my_role() = 'expert' AND
    public.expert_has_assignment(id)
  );

CREATE POLICY "Experts can read requests with assigned entities"
  ON public.requests
  FOR SELECT USING (
    public.get_my_role() = 'expert' AND
    public.expert_has_request(id)
  );
