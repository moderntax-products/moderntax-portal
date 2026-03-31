-- Migration: Add expert credential fields to profiles
-- These fields are required for Form 8821 Section 2 (Designee)
-- Run this in Supabase SQL Editor

-- Add expert-specific credential columns to profiles table
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS caf_number TEXT,
ADD COLUMN IF NOT EXISTS ptin TEXT,
ADD COLUMN IF NOT EXISTS phone_number TEXT,
ADD COLUMN IF NOT EXISTS fax_number TEXT,
ADD COLUMN IF NOT EXISTS address TEXT,
ADD COLUMN IF NOT EXISTS city TEXT,
ADD COLUMN IF NOT EXISTS state TEXT,
ADD COLUMN IF NOT EXISTS zip_code TEXT;

-- Add comment explaining these columns
COMMENT ON COLUMN profiles.caf_number IS 'IRS Centralized Authorization File number (for experts)';
COMMENT ON COLUMN profiles.ptin IS 'Preparer Tax Identification Number (for experts)';
COMMENT ON COLUMN profiles.phone_number IS 'Contact phone number';
COMMENT ON COLUMN profiles.fax_number IS 'Fax number (optional, for 8821 forms)';
COMMENT ON COLUMN profiles.address IS 'Street address';
COMMENT ON COLUMN profiles.city IS 'City';
COMMENT ON COLUMN profiles.state IS 'State abbreviation';
COMMENT ON COLUMN profiles.zip_code IS 'ZIP code';

-- RLS: Allow experts to update their own profile credential fields
-- Check if a policy already exists for self-update; if not, create one
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'profiles'
    AND policyname = 'experts_update_own_profile'
  ) THEN
    EXECUTE 'CREATE POLICY experts_update_own_profile ON profiles
      FOR UPDATE USING (auth.uid() = id)
      WITH CHECK (auth.uid() = id)';
  END IF;
END $$;
