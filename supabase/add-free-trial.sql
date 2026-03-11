-- Add free trial tracking to clients table
-- Run this in Supabase SQL Editor

ALTER TABLE clients ADD COLUMN IF NOT EXISTS free_trial boolean DEFAULT true;

-- Mark Centerstone and TMC as having completed their free trials
UPDATE clients SET free_trial = false WHERE slug IN ('centerstone', 'tmc');
