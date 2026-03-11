-- ModernTax Portal Schema
-- Postgres with Supabase auth integration
-- Drops and recreates portal tables (clients, profiles, requests, request_entities, notifications)

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "http";

-- Drop existing portal tables (in reverse dependency order)
DROP TABLE IF EXISTS public.notifications CASCADE;
DROP TABLE IF EXISTS public.request_entities CASCADE;
DROP TABLE IF EXISTS public.requests CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;
DROP TABLE IF EXISTS public.clients CASCADE;

-- Clients table
CREATE TABLE public.clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  domain TEXT,
  logo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Profiles table (extends Supabase auth.users)
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('processor', 'manager', 'admin')),
  client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Requests table
CREATE TABLE public.requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  account_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (
    status IN ('submitted', '8821_sent', '8821_signed', 'irs_queue', 'processing', 'completed', 'failed')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  notes TEXT,
  CONSTRAINT account_number_length CHECK (char_length(account_number) > 0)
);

-- Request Entities table
CREATE TABLE public.request_entities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id UUID NOT NULL REFERENCES public.requests(id) ON DELETE CASCADE,
  entity_name TEXT NOT NULL,
  ein TEXT NOT NULL,
  form_type TEXT NOT NULL CHECK (form_type IN ('1040', '1065', '1120', '1120S')),
  years TEXT[] NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  gross_receipts JSONB,
  compliance_score INT CHECK (compliance_score >= 0 AND compliance_score <= 100),
  transcript_urls TEXT[],
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Notifications table
CREATE TABLE public.notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  request_id UUID REFERENCES public.requests(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('confirmation', 'completion', 'nudge')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel TEXT NOT NULL DEFAULT 'email',
  read_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX idx_profiles_client_id ON public.profiles(client_id);
CREATE INDEX idx_profiles_email ON public.profiles(email);
CREATE INDEX idx_requests_client_id ON public.requests(client_id);
CREATE INDEX idx_requests_requested_by ON public.requests(requested_by);
CREATE INDEX idx_requests_status ON public.requests(status);
CREATE INDEX idx_requests_created_at ON public.requests(created_at DESC);
CREATE INDEX idx_request_entities_request_id ON public.request_entities(request_id);
CREATE INDEX idx_notifications_user_id ON public.notifications(user_id);
CREATE INDEX idx_notifications_request_id ON public.notifications(request_id);

-- Row Level Security (RLS)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

-- Profiles RLS Policies
CREATE POLICY "Users can read own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can read profiles from same client" ON public.profiles
  FOR SELECT USING (
    client_id = (
      SELECT client_id FROM public.profiles WHERE id = auth.uid()
    )
  );

CREATE POLICY "Admins can read all profiles" ON public.profiles
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Requests RLS Policies
CREATE POLICY "Users can read requests from own client" ON public.requests
  FOR SELECT USING (
    client_id = (
      SELECT client_id FROM public.profiles WHERE id = auth.uid()
    )
  );

CREATE POLICY "Users can insert requests for own client" ON public.requests
  FOR INSERT WITH CHECK (
    client_id = (
      SELECT client_id FROM public.profiles WHERE id = auth.uid()
    ) AND
    requested_by = auth.uid()
  );

CREATE POLICY "Users can update own requests" ON public.requests
  FOR UPDATE USING (
    client_id = (
      SELECT client_id FROM public.profiles WHERE id = auth.uid()
    )
  );

CREATE POLICY "Admins can read all requests" ON public.requests
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Request Entities RLS Policies
CREATE POLICY "Users can read entities from own client requests" ON public.request_entities
  FOR SELECT USING (
    request_id IN (
      SELECT r.id FROM public.requests r
      WHERE r.client_id = (
        SELECT client_id FROM public.profiles WHERE id = auth.uid()
      )
    )
  );

-- Notifications RLS Policies
CREATE POLICY "Users can read own notifications" ON public.notifications
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "System can insert notifications" ON public.notifications
  FOR INSERT WITH CHECK (true);

-- Clients RLS Policies
CREATE POLICY "Anyone can read clients" ON public.clients
  FOR SELECT USING (true);

-- Trigger: Auto-create profile on user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'full_name', ''),
    COALESCE(new.raw_user_meta_data->>'role', 'processor')
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Seed data: Clients
INSERT INTO public.clients (name, slug, domain, created_at, updated_at) VALUES
  ('Centerstone SBA Lending', 'centerstone', 'teamcenterstone.com', NOW(), NOW()),
  ('TMC Financing', 'tmc', 'tmcfinancing.com', NOW(), NOW()),
  ('Clearfirm', 'clearfirm', 'clearfirm.com', NOW(), NOW())
ON CONFLICT DO NOTHING;

-- Create profile for existing admin user
INSERT INTO public.profiles (id, email, full_name, role, client_id)
SELECT '4a62ae4c-c3c4-4399-87e1-63f4f6851153', 'matt@moderntax.io', 'Matt Parker', 'admin', c.id
FROM public.clients c WHERE c.slug = 'centerstone'
ON CONFLICT (id) DO NOTHING;
