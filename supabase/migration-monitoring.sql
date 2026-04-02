-- Migration: Transcript Monitoring Subscriptions
-- Enables processors to enroll entities in recurring transcript re-pulls
-- Pricing: $19.99 enrollment + $39.99 per update pull

-- Monitoring subscriptions table
CREATE TABLE IF NOT EXISTS public.entity_monitoring (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES public.request_entities(id) ON DELETE CASCADE,
  request_id UUID NOT NULL REFERENCES public.requests(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  enrolled_by UUID NOT NULL REFERENCES auth.users(id),

  -- Schedule
  frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (
    frequency IN ('weekly', 'monthly', 'quarterly', 'custom')
  ),
  custom_interval_days INT, -- only used when frequency = 'custom'
  next_pull_date DATE NOT NULL,
  last_pull_date DATE,

  -- Enrollment window
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ, -- optional: auto-cancel after this date (up to 10 years from 8821)
  cancelled_at TIMESTAMPTZ,

  -- Status
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'paused', 'cancelled', 'expired')
  ),

  -- Billing
  enrollment_fee NUMERIC(10,2) NOT NULL DEFAULT 19.99,
  per_pull_fee NUMERIC(10,2) NOT NULL DEFAULT 39.99,
  total_pulls_completed INT NOT NULL DEFAULT 0,
  total_billed NUMERIC(10,2) NOT NULL DEFAULT 19.99, -- starts at enrollment fee

  -- Pull history stored as JSONB array
  pull_history JSONB NOT NULL DEFAULT '[]'::JSONB,
  -- Example: [{ "date": "2026-05-01", "status": "completed", "transcript_count": 4 }]

  -- AI summary (latest)
  latest_summary TEXT,
  latest_summary_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_entity_monitoring_entity ON public.entity_monitoring(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_monitoring_client ON public.entity_monitoring(client_id);
CREATE INDEX IF NOT EXISTS idx_entity_monitoring_next_pull ON public.entity_monitoring(next_pull_date) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_entity_monitoring_status ON public.entity_monitoring(status);

-- Unique: one active subscription per entity
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_monitoring_unique_active
  ON public.entity_monitoring(entity_id) WHERE status IN ('active', 'paused');

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_entity_monitoring_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_entity_monitoring_updated_at ON public.entity_monitoring;
CREATE TRIGGER set_entity_monitoring_updated_at
  BEFORE UPDATE ON public.entity_monitoring
  FOR EACH ROW
  EXECUTE FUNCTION update_entity_monitoring_timestamp();

-- RLS
ALTER TABLE public.entity_monitoring ENABLE ROW LEVEL SECURITY;

-- Admins can do everything
CREATE POLICY "admin_full_access_monitoring" ON public.entity_monitoring
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Processors/managers can view and manage their client's monitoring
CREATE POLICY "client_access_monitoring" ON public.entity_monitoring
  FOR ALL USING (
    client_id IN (
      SELECT client_id FROM public.profiles WHERE id = auth.uid()
    )
  );

COMMENT ON TABLE public.entity_monitoring IS 'Transcript monitoring subscriptions for recurring IRS pulls';
COMMENT ON COLUMN public.entity_monitoring.frequency IS 'Pull frequency: weekly, monthly, quarterly, or custom interval';
COMMENT ON COLUMN public.entity_monitoring.enrollment_fee IS 'One-time enrollment fee ($19.99 default)';
COMMENT ON COLUMN public.entity_monitoring.per_pull_fee IS 'Per-update fee ($39.99 default) includes up to 10 years, AI summary, success guarantee';
