-- ============================================================
-- Fix: Admin cannot see request_entities from other clients
--
-- Problem: The request_entities table has RLS policies that only
-- allow users to see entities from their own client's requests.
-- Admins have a policy to see all requests, but there was no
-- matching admin policy on request_entities. This caused the
-- admin request detail page to show 0 entities for requests
-- from other clients.
--
-- Solution: Add admin SELECT and UPDATE policies on request_entities.
-- ============================================================

-- Admin can read all request entities
CREATE POLICY "Admins can read all request entities"
  ON public.request_entities
  FOR SELECT USING (public.get_my_role() = 'admin');

-- Admin can update all request entities
CREATE POLICY "Admins can update all request entities"
  ON public.request_entities
  FOR UPDATE USING (public.get_my_role() = 'admin');
