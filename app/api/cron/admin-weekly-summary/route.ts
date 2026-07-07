/**
 * Cron: admin weekly gross report
 * GET /api/cron/admin-weekly-summary
 *
 * Emails a gross financial rollup (revenue, six-category COGS, gross margin,
 * revenue-by-client) for the trailing 7 days. Runs Monday morning.
 *
 * Auth: Vercel cron Bearer secret (CRON_SECRET).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { computeGrossSummary, renderGrossSummaryEmail } from '@/lib/gross-summary';
import sgMail from '@sendgrid/mail';

export const runtime = 'nodejs';
export const maxDuration = 60;

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'matt@moderntax.io';

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  try {
    const supabase = createAdminClient();
    const now = new Date();
    // Trailing 7 full days ending at the start of today (UTC).
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const start = new Date(end.getTime() - 7 * 86_400_000);

    const summary = await computeGrossSummary(supabase, start.toISOString(), end.toISOString(), 'Weekly');

    if (process.env.SENDGRID_API_KEY) {
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      const { subject, html } = renderGrossSummaryEmail(summary);
      await sgMail.send({ to: ADMIN_EMAIL, from: { email: 'no-reply@moderntax.io', name: 'ModernTax Reports' }, subject, html });
    }

    return NextResponse.json({
      success: true,
      period: { start: summary.periodStart, end: summary.periodEnd },
      revenue: summary.revenue,
      cogs: summary.cogs.total,
      gross_margin: summary.grossMarginDollars,
      gross_margin_pct: summary.grossMarginPct,
      completions: summary.totalCompleted,
    });
  } catch (err) {
    console.error('[admin-weekly-summary] error:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'weekly summary failed' }, { status: 500 });
  }
}
