-- Trial Funnel Events — June 2026
-- End-to-end funnel tracking from signup through invoice paid.

CREATE TABLE IF NOT EXISTS public.trial_funnel_events (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type  TEXT        NOT NULL,
  client_id   UUID        REFERENCES public.clients(id) ON DELETE SET NULL,
  user_id     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE public.trial_funnel_events
    ADD CONSTRAINT trial_funnel_events_event_type_check
    CHECK (event_type IN (
      'signup_submitted','signup_approved','signup_rejected','signup_disqualified',
      'dashboard_visited','request_submitted','pull_completed','trial_exhausted',
      'paywall_seen','card_capture_initiated','card_captured',
      'trial_converted','conversion_failed','trial_expired',
      'pilot_offered','pilot_purchased','invoice_issued','invoice_paid',
      'tier_upgraded','reminder_sent','hot_trial_alerted','review_nudge_sent'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_tfe_client_type ON public.trial_funnel_events(client_id, event_type);
CREATE INDEX IF NOT EXISTS idx_tfe_type_created ON public.trial_funnel_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tfe_created ON public.trial_funnel_events(created_at DESC);

ALTER TABLE public.trial_funnel_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trial_funnel_events_admin_all ON public.trial_funnel_events;
CREATE POLICY trial_funnel_events_admin_all ON public.trial_funnel_events
  FOR ALL USING (
    auth.role() = 'service_role' OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

COMMENT ON TABLE public.trial_funnel_events IS 'End-to-end funnel tracking. Powers admin conversion dashboard and hot-trial alerts.';
