-- Migration: Add voice_sample_url and sor_id to profiles for IRS PPS call automation
-- voice_sample_url: URL to expert's recorded voice sample for VoxCPM2 voice cloning
-- sor_id: IRS Secure Object Repository inbox username for transcript delivery
--
-- Run in Supabase SQL Editor

-- Add columns if they don't already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'voice_sample_url'
  ) THEN
    ALTER TABLE profiles ADD COLUMN voice_sample_url text;
    COMMENT ON COLUMN profiles.voice_sample_url IS 'URL to voice sample audio for VoxCPM2 zero-shot cloning on IRS PPS calls';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'sor_id'
  ) THEN
    ALTER TABLE profiles ADD COLUMN sor_id text;
    COMMENT ON COLUMN profiles.sor_id IS 'IRS Secure Object Repository inbox username';
  END IF;
END $$;

-- Create voice-samples folder policy in uploads bucket (experts can upload their own)
-- Note: The uploads bucket should already exist. Voice samples are stored at:
-- uploads/voice-samples/{user_id}/voice-sample.webm
