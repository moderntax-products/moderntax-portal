-- ModernTax Portal Schema v2
-- Updated for real CSV/PDF upload workflows
-- Drops and recreates portal tables with new fields

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Drop existing portal tables (in reverse dependency order)
DROP TABLE IF EXISTS public.notifications CASCADE;
DROP TABLE IF EXISTS public.request_entities CASCADE;
DROP TABLE IF EXISTS public.requests CASCADE;
DROP TABLE IF EXISTS public.batches CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;
DROP TABLE IF EXISTS public.clients CASCADE;

-- Drop old helper functions (will recreate)
DROP FUNCTION IF EXISTS public.get_my_client_id();
DROP FUNCTION IF EXISTS public.get_my_role();

-- ============================================================
-- TABLES
-- ============================================================

-- Clients table
CREATE TABLE public.clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  domain TEXT,
  logo_url TEXT,
  intake_methods TEXT[] NOT NULL DEFAULT '{csv,pdf,manual}',
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

-- Batches table (groups file uploads)
CREATE TABLE public.batches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  uploaded_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  intake_method TEXT NOT NULL CHECK (intake_method IN ('csv', 'pdf', 'manual')),
  source_file_url TEXT,
  original_filename TEXT,
  entity_count INT NOT NULL DEFAULT 0,
  request_count INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Requests table (one per loan/credit application)
CREATE TABLE public.requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  batch_id UUID REFERENCES public.batches(id) ON DELETE SET NULL,
  loan_number TEXT NOT NULL,
  intake_method TEXT NOT NULL DEFAULT 'manual' CHECK (intake_method IN ('csv', 'pdf', 'manual')),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (
    status IN ('submitted', '8821_sent', '8821_signed', 'irs_queue', 'processing', 'completed', 'failed')
  ),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT loan_number_length CHECK (char_length(loan_number) > 0)
);

-- Request Entities table (one per taxpayer/entity within a request)
CREATE TABLE public.request_entities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id UUID NOT NULL REFERENCES public.requests(id) ON DELETE CASCADE,
  entity_name TEXT NOT NULL,
  tid TEXT NOT NULL,
  tid_kind TEXT NOT NULL DEFAULT 'EIN' CHECK (tid_kind IN ('EIN', 'SSN')),
  address TEXT,
  city TEXT,
  state TEXT,
  zip_code TEXT,
  form_type TEXT NOT NULL CHECK (form_type IN ('1040', '1065', '1120', '1120S')),
  years TEXT[] NOT NULL,
  -- Signer info (from CSV or PDF)
  signer_first_name TEXT,
  signer_last_name TEXT,
  signature_id TEXT,
  signature_created_at TIMESTAMPTZ,
  -- File references
  signed_8821_url TEXT,
  -- Processing results
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'submitted', '8821_sent', '8821_signed', 'irs_queue', 'processing', 'completed', 'failed')
  ),
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
  type TEXT NOT NULL CHECK (type IN ('confirmation', 'completion', 'nudge', 'batch_complete')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel TEXT NOT NULL DEFAULT 'email',
  read_at TIMESTAMPTZ
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_profiles_client_id ON public.profiles(client_id);
CREATE INDEX idx_profiles_email ON public.profiles(email);
CREATE INDEX idx_batches_client_id ON public.batches(client_id);
CREATE INDEX idx_batches_uploaded_by ON public.batches(uploaded_by);
CREATE INDEX idx_requests_client_id ON public.requests(client_id);
CREATE INDEX idx_requests_requested_by ON public.requests(requested_by);
CREATE INDEX idx_requests_batch_id ON public.requests(batch_id);
CREATE INDEX idx_requests_loan_number ON public.requests(loan_number);
CREATE INDEX idx_requests_status ON public.requests(status);
CREATE INDEX idx_requests_created_at ON public.requests(created_at DESC);
CREATE INDEX idx_request_entities_request_id ON public.request_entities(request_id);
CREATE INDEX idx_request_entities_tid ON public.request_entities(tid);
CREATE INDEX idx_request_entities_status ON public.request_entities(status);
CREATE INDEX idx_notifications_user_id ON public.notifications(user_id);
CREATE INDEX idx_notifications_request_id ON public.notifications(request_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Helper functions (SECURITY DEFINER to avoid RLS recursion)
CREATE OR REPLACE FUNCTION public.get_my_client_id()
RETURNS UUID AS $$
  SELECT client_id FROM public.profiles WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Clients: anyone can read
CREATE POLICY "Anyone can read clients" ON public.clients
  FOR SELECT USING (true);

-- Profiles
CREATE POLICY "Users can read own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can read profiles from same client" ON public.profiles
  FOR SELECT USING (client_id = public.get_my_client_id());

CREATE POLICY "Admins can read all profiles" ON public.profiles
  FOR SELECT USING (public.get_my_role() = 'admin');

-- Batches
CREATE POLICY "Users can read batches from own client" ON public.batches
  FOR SELECT USING (client_id = public.get_my_client_id());

CREATE POLICY "Users can insert batches for own client" ON public.batches
  FOR INSERT WITH CHECK (
    client_id = public.get_my_client_id() AND uploaded_by = auth.uid()
  );

-- Requests
CREATE POLICY "Users can read requests from own client" ON public.requests
  FOR SELECT USING (client_id = public.get_my_client_id());

CREATE POLICY "Users can insert requests for own client" ON public.requests
  FOR INSERT WITH CHECK (
    client_id = public.get_my_client_id() AND requested_by = auth.uid()
  );

CREATE POLICY "Users can update own client requests" ON public.requests
  FOR UPDATE USING (client_id = public.get_my_client_id());

CREATE POLICY "Admins can read all requests" ON public.requests
  FOR SELECT USING (public.get_my_role() = 'admin');

-- Request Entities
CREATE POLICY "Users can read entities from own client requests" ON public.request_entities
  FOR SELECT USING (
    request_id IN (
      SELECT id FROM public.requests WHERE client_id = public.get_my_client_id()
    )
  );

CREATE POLICY "Users can insert entities for own client requests" ON public.request_entities
  FOR INSERT WITH CHECK (
    request_id IN (
      SELECT id FROM public.requests WHERE client_id = public.get_my_client_id()
    )
  );

CREATE POLICY "Users can update entities from own client requests" ON public.request_entities
  FOR UPDATE USING (
    request_id IN (
      SELECT id FROM public.requests WHERE client_id = public.get_my_client_id()
    )
  );

-- Notifications
CREATE POLICY "Users can read own notifications" ON public.notifications
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "System can insert notifications" ON public.notifications
  FOR INSERT WITH CHECK (true);

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Auto-create profile on user signup
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

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_requests_updated_at
  BEFORE UPDATE ON public.requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER update_request_entities_updated_at
  BEFORE UPDATE ON public.request_entities
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- STORAGE (run in Supabase dashboard if this errors)
-- ============================================================

-- Create storage bucket for uploads
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'uploads',
  'uploads',
  false,
  52428800, -- 50MB
  ARRAY['text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- Storage policies
CREATE POLICY "Users can upload files" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'uploads' AND auth.uid() IS NOT NULL
  );

CREATE POLICY "Users can read own uploads" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'uploads' AND auth.uid() IS NOT NULL
  );

-- ============================================================
-- SEED DATA
-- ============================================================

-- Clients
INSERT INTO public.clients (name, slug, domain, intake_methods, created_at, updated_at) VALUES
  ('Centerstone SBA Lending', 'centerstone', 'teamcenterstone.com', '{csv,manual}', NOW(), NOW()),
  ('TMC Financing', 'tmc', 'tmcfinancing.com', '{pdf,manual}', NOW(), NOW()),
  ('Clearfirm', 'clearfirm', 'clearfirm.com', '{csv,pdf,manual}', NOW(), NOW())
ON CONFLICT DO NOTHING;

-- Create profile for existing admin user
INSERT INTO public.profiles (id, email, full_name, role, client_id)
SELECT '4a62ae4c-c3c4-4399-87e1-63f4f6851153', 'matt@moderntax.io', 'Matt Parker', 'admin', c.id
FROM public.clients c WHERE c.slug = 'centerstone'
ON CONFLICT (id) DO UPDATE SET
  client_id = EXCLUDED.client_id,
  role = EXCLUDED.role;
