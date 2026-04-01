-- ClearFirm Webhook Integration Migration
-- Adds webhook delivery infrastructure for automated transcript delivery

-- 1. Webhook config on clients table
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS webhook_url TEXT;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS webhook_secret TEXT;

-- 2. HTML transcript storage alongside existing PDF transcript_urls
ALTER TABLE public.request_entities ADD COLUMN IF NOT EXISTS transcript_html_urls TEXT[];

-- 3. Webhook delivery queue with retry tracking
CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id UUID NOT NULL REFERENCES public.requests(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  webhook_url TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'sending', 'delivered', 'failed', 'dead')
  ),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  last_attempt_at TIMESTAMPTZ,
  last_status_code INT,
  last_error TEXT,
  next_retry_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry
  ON public.webhook_deliveries(next_retry_at)
  WHERE status = 'failed';

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_request
  ON public.webhook_deliveries(request_id);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status
  ON public.webhook_deliveries(status);

-- 4. Seed ClearFirm webhook URL
UPDATE public.clients
SET webhook_url = 'https://clearfirm-api.onrender.com/api/v1/webhook/moderntax'
WHERE slug = 'clearfirm';

-- 5. Enable RLS on webhook_deliveries (admin-only access)
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access to webhook_deliveries"
  ON public.webhook_deliveries
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

-- Service role bypasses RLS, so cron jobs using adminClient work automatically
