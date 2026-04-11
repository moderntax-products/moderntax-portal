-- Migration: Add voice_id and sor_id to profiles for IRS PPS call automation
-- voice_id: ElevenLabs cloned voice ID — AI agent sounds like the actual expert
-- sor_id: IRS Secure Object Repository inbox username for transcript delivery
--
-- Run in Supabase SQL Editor

-- Add columns if they don't already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'voice_id'
  ) THEN
    ALTER TABLE profiles ADD COLUMN voice_id text;
    COMMENT ON COLUMN profiles.voice_id IS 'ElevenLabs cloned voice ID for Bland AI calls';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'sor_id'
  ) THEN
    ALTER TABLE profiles ADD COLUMN sor_id text;
    COMMENT ON COLUMN profiles.sor_id IS 'IRS Secure Object Repository inbox username';
  END IF;
END $$;

-- Set Matt Parker's voice_id from ElevenLabs clone
-- Replace YOUR_ELEVENLABS_VOICE_ID with the actual voice ID from ElevenLabs dashboard
UPDATE profiles
SET voice_id = 'YOUR_ELEVENLABS_VOICE_ID'
WHERE email = 'matthewaparker@icloud.com';
