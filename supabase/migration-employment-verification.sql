-- Migration: Employment Verification Integration
-- Adds support for Employer.com API-based employment/wage & income verification requests
-- Run in Supabase SQL Editor

-- 1. Expand requests table
ALTER TABLE public.requests ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'transcript';
ALTER TABLE public.requests ADD COLUMN IF NOT EXISTS external_request_token TEXT;

-- Add unique constraint and indexes
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requests_external_request_token_key') THEN
    ALTER TABLE public.requests ADD CONSTRAINT requests_external_request_token_key UNIQUE (external_request_token);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_requests_external_token ON public.requests(external_request_token);
CREATE INDEX IF NOT EXISTS idx_requests_product_type ON public.requests(product_type);

-- 2. Expand request_entities table
ALTER TABLE public.request_entities ADD COLUMN IF NOT EXISTS employment_data JSONB;

-- 3. Expand clients table for API clients
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS api_key TEXT;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS api_request_limit INT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_api_key_key') THEN
    ALTER TABLE public.clients ADD CONSTRAINT clients_api_key_key UNIQUE (api_key);
  END IF;
END $$;

-- 4. Seed Employer.com as a client
INSERT INTO public.clients (name, slug, domain, intake_methods, api_key, api_request_limit, free_trial)
VALUES ('Employer.com', 'employercom', 'employer.com', '{api}', 'mt_live_emp_employercom_prod', 25, true)
ON CONFLICT (slug) DO UPDATE SET
  api_key = EXCLUDED.api_key,
  api_request_limit = EXCLUDED.api_request_limit;
