-- Migration: Self-Service Signup Support
-- Add title column to profiles for job title storage

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS title TEXT DEFAULT NULL;
