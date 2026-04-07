-- Compliance Drip Email Marketing System
-- Tracks email sequences sent to entities with IRS compliance flags

CREATE TABLE IF NOT EXISTS public.compliance_drip (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_id UUID NOT NULL REFERENCES public.request_entities(id) ON DELETE CASCADE,

  -- Resolve token for landing page (unique per entity)
  resolve_token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),

  -- Flag classification for segmented messaging
  flag_category TEXT NOT NULL CHECK (
    flag_category IN ('balance_due', 'unfiled_returns', 'penalties', 'mixed', 'other')
  ),
  flag_severity TEXT NOT NULL CHECK (flag_severity IN ('CRITICAL', 'WARNING')),

  -- Financial snapshot at time of flagging (denormalized for email templates)
  balance_due NUMERIC(12,2),
  accrued_penalty NUMERIC(12,2),
  accrued_interest NUMERIC(12,2),
  total_exposure NUMERIC(12,2),  -- balance + penalty + interest

  -- Drip sequence tracking
  drip_stage INTEGER NOT NULL DEFAULT 0,  -- 0=initial, 1=day3, 2=day7, 3=day14
  last_email_sent_at TIMESTAMPTZ,
  next_email_due_at TIMESTAMPTZ,

  -- Engagement tracking
  email_0_sent_at TIMESTAMPTZ,      -- Day 0: Initial alert
  email_1_sent_at TIMESTAMPTZ,      -- Day 3: Dollar-specific urgency
  email_2_sent_at TIMESTAMPTZ,      -- Day 7: Deadline reminder
  email_3_sent_at TIMESTAMPTZ,      -- Day 14: Last chance

  -- Engagement events (updated via SendGrid webhook or landing page)
  last_opened_at TIMESTAMPTZ,
  last_clicked_at TIMESTAMPTZ,
  open_count INTEGER DEFAULT 0,
  click_count INTEGER DEFAULT 0,

  -- Landing page visits
  landing_page_visited_at TIMESTAMPTZ,
  landing_page_visit_count INTEGER DEFAULT 0,

  -- Conversion
  consultation_booked_at TIMESTAMPTZ,
  consultation_booked BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  resolved BOOLEAN DEFAULT FALSE,

  -- Opt-out
  unsubscribed BOOLEAN DEFAULT FALSE,
  unsubscribed_at TIMESTAMPTZ,

  -- Signer info (denormalized for quick access)
  signer_email TEXT NOT NULL,
  signer_name TEXT,
  entity_name TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_compliance_drip_entity ON public.compliance_drip(entity_id);
CREATE INDEX IF NOT EXISTS idx_compliance_drip_token ON public.compliance_drip(resolve_token);
CREATE INDEX IF NOT EXISTS idx_compliance_drip_next_due ON public.compliance_drip(next_email_due_at)
  WHERE NOT unsubscribed AND NOT consultation_booked AND drip_stage < 4;
CREATE INDEX IF NOT EXISTS idx_compliance_drip_stage ON public.compliance_drip(drip_stage);

-- RLS
ALTER TABLE public.compliance_drip ENABLE ROW LEVEL SECURITY;

-- Admins can read/manage all drip records
CREATE POLICY "admins_manage_compliance_drip"
  ON public.compliance_drip
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Service role has full access (for cron/webhook operations)
CREATE POLICY "service_role_compliance_drip"
  ON public.compliance_drip
  FOR ALL USING (auth.role() = 'service_role');
