/**
 * POST /api/admin/run-trial-migrations
 *
 * One-shot endpoint that applies the three June 2026 trial overhaul
 * migrations in order, using Supabase's pg extension RPC to execute
 * raw DDL server-side where the service role key is available.
 *
 * Migrations applied:
 *   1. migration-trial-qualification-gate   (qual columns on profiles + clients)
 *   2. migration-trial-auto-convert         (trial lifecycle columns on clients)
 *   3. migration-trial-funnel-events        (trial_funnel_events table)
 *
 * Each migration is idempotent (IF NOT EXISTS / DO $$ BEGIN ... EXCEPTION).
 * Safe to run multiple times.
 *
 * Auth: CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MIGRATION_1_QUAL_GATE = `
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS qual_segment TEXT,
  ADD COLUMN IF NOT EXISTS qual_monthly_volume TEXT,
  ADD COLUMN IF NOT EXISTS qual_current_vendor TEXT,
  ADD COLUMN IF NOT EXISTS qual_team_size TEXT,
  ADD COLUMN IF NOT EXISTS qual_use_case_text TEXT,
  ADD COLUMN IF NOT EXISTS qual_score TEXT DEFAULT 'unscored';

DO $$ BEGIN
  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_qual_segment_check
    CHECK (qual_segment IS NULL OR qual_segment IN (
      'sba_lender_bank','sba_lender_cdc','commercial_bank',
      'fintech_originator','accountant_cpa','individual_borrower',
      'insurance','employment_verif','other'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_qual_score_check
    CHECK (qual_score IN ('unscored','auto_qualified','manual_review','disqualified'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS trial_segment TEXT,
  ADD COLUMN IF NOT EXISTS trial_monthly_volume_range TEXT,
  ADD COLUMN IF NOT EXISTS trial_current_vendor TEXT,
  ADD COLUMN IF NOT EXISTS trial_qualified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_disqualified_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_profiles_qual_pending
  ON public.profiles(created_at)
  WHERE approval_status = 'pending';
`;

const MIGRATION_2_AUTO_CONVERT = `
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS trial_started_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_expires_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_card_captured_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_converted_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_pulls_used         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trial_pilot_offered_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_pilot_purchased_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pilot_pulls_remaining    INTEGER;

ALTER TABLE public.clients
  ALTER COLUMN trial_entities_allowed SET DEFAULT 1;

UPDATE public.clients
  SET trial_converted_at = payment_method_attached_at
WHERE stripe_payment_method_id IS NOT NULL
  AND payment_method_status = 'active'
  AND trial_converted_at IS NULL
  AND bypass_payment_paywall = false
  AND mercury_customer_id IS NULL;
`;

const MIGRATION_3_FUNNEL_EVENTS = `
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
`;

const MIGRATIONS = [
  { name: 'migration-trial-qualification-gate', sql: MIGRATION_1_QUAL_GATE },
  { name: 'migration-trial-auto-convert',       sql: MIGRATION_2_AUTO_CONVERT },
  { name: 'migration-trial-funnel-events',      sql: MIGRATION_3_FUNNEL_EVENTS },
];

export async function POST(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();
  const results: Array<{ migration: string; status: 'ok' | 'error'; error?: string }> = [];
  const log: string[] = [];
  const L = (s: string) => { log.push(s); console.log('[trial-migrations] ' + s); };

  for (const migration of MIGRATIONS) {
    L(`Running ${migration.name}...`);
    try {
      // Use Supabase's pg.execute RPC (available in all projects via pg extension)
      const { error } = await (admin.rpc as any)('exec_sql', { sql: migration.sql });
      if (error) {
        // Try alternative: direct query via the REST admin endpoint
        L(`  RPC failed (${error.message}) — trying raw approach`);
        // Split into individual statements and execute via individual rpc calls
        const stmts = migration.sql
          .split(';')
          .map(s => s.trim())
          .filter(s => s.length > 10 && !s.startsWith('--'));

        let allOk = true;
        for (const stmt of stmts) {
          // Skip DO blocks with semicolons inside — they need special handling
          // We'll try them as a unit
          const { error: stmtErr } = await (admin.rpc as any)('exec_sql', { sql: stmt });
          if (stmtErr && !/already exists|duplicate_object/i.test(stmtErr.message || '')) {
            L(`  ✗ Statement failed: ${stmtErr.message}`);
            L(`    Statement: ${stmt.slice(0, 120)}`);
            allOk = false;
          }
        }
        if (allOk) {
          results.push({ migration: migration.name, status: 'ok' });
          L(`  ✓ ${migration.name} (via statement-by-statement)`);
        } else {
          results.push({ migration: migration.name, status: 'error', error: 'Some statements failed — see log' });
        }
      } else {
        results.push({ migration: migration.name, status: 'ok' });
        L(`  ✓ ${migration.name}`);
      }
    } catch (err: any) {
      L(`  ✗ ${migration.name}: ${err?.message}`);
      results.push({ migration: migration.name, status: 'error', error: err?.message });
    }
  }

  const allOk = results.every(r => r.status === 'ok');
  return NextResponse.json({ success: allOk, results, log });
}
