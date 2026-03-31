-- Migration: Add reorder support
-- Adds reordered_from column to requests table for tracking reorder provenance
-- Adds 'reorder' to intake_method CHECK constraint

-- Add reorder tracking column
ALTER TABLE public.requests ADD COLUMN IF NOT EXISTS reordered_from UUID REFERENCES public.requests(id) ON DELETE SET NULL;

-- Update intake_method CHECK constraint to include 'reorder'
ALTER TABLE public.requests DROP CONSTRAINT IF EXISTS requests_intake_method_check;
ALTER TABLE public.requests ADD CONSTRAINT requests_intake_method_check
  CHECK (intake_method IN ('csv', 'pdf', 'manual', 'api', 'reorder'));
