-- Fix infinite recursion in RLS policies
-- The profiles policies were self-referencing, causing infinite recursion

-- Helper functions that bypass RLS (SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.get_my_client_id()
RETURNS UUID AS $$
  SELECT client_id FROM public.profiles WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Drop old broken policies
DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can read profiles from same client" ON public.profiles;
DROP POLICY IF EXISTS "Admins can read all profiles" ON public.profiles;

DROP POLICY IF EXISTS "Users can read requests from own client" ON public.requests;
DROP POLICY IF EXISTS "Users can insert requests for own client" ON public.requests;
DROP POLICY IF EXISTS "Users can update own requests" ON public.requests;
DROP POLICY IF EXISTS "Admins can read all requests" ON public.requests;

DROP POLICY IF EXISTS "Users can read entities from own client requests" ON public.request_entities;

-- Recreate profiles policies using helper functions (no recursion)
CREATE POLICY "Users can read own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can read profiles from same client" ON public.profiles
  FOR SELECT USING (client_id = public.get_my_client_id());

CREATE POLICY "Admins can read all profiles" ON public.profiles
  FOR SELECT USING (public.get_my_role() = 'admin');

-- Recreate requests policies using helper functions
CREATE POLICY "Users can read requests from own client" ON public.requests
  FOR SELECT USING (client_id = public.get_my_client_id());

CREATE POLICY "Users can insert requests for own client" ON public.requests
  FOR INSERT WITH CHECK (
    client_id = public.get_my_client_id() AND
    requested_by = auth.uid()
  );

CREATE POLICY "Users can update own requests" ON public.requests
  FOR UPDATE USING (client_id = public.get_my_client_id());

CREATE POLICY "Admins can read all requests" ON public.requests
  FOR SELECT USING (public.get_my_role() = 'admin');

-- Recreate request_entities policy using helper function
CREATE POLICY "Users can read entities from own client requests" ON public.request_entities
  FOR SELECT USING (
    request_id IN (
      SELECT r.id FROM public.requests r
      WHERE r.client_id = public.get_my_client_id()
    )
  );
