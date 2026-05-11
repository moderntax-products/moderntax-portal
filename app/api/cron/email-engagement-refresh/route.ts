/**
 * Refresh the email_engagement_summary materialized view.
 *
 * The view aggregates per-recipient open/click/delivery counts from
 * sendgrid_events. We refresh on a 5-minute cron so the admin
 * engagement page is always close-to-fresh without paying for the
 * GROUP BY on every page load.
 *
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY` requires a unique index on
 * the view (created by the migration) and lets readers keep querying
 * the stale version while the refresh runs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireBearer } from '@/lib/auth-util';
import { createAdminClient } from '@/lib/supabase-server';

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const supabase = createAdminClient();
  // Supabase RPC over a one-shot SQL statement. We define `refresh_email_engagement_summary()`
  // as a SECURITY DEFINER function in the migration so the service-role
  // can call it without needing direct DDL privileges.
  const { error } = await (supabase as any).rpc('refresh_email_engagement_summary');

  if (error) {
    console.error('[email-engagement-refresh] refresh failed:', error);
    return NextResponse.json(
      { error: 'refresh failed', details: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, refreshed_at: new Date().toISOString() });
}
