/**
 * Admin Daily Summary Cron Job
 * Sends daily operations summary to all admins
 * GET /api/cron/admin-daily-summary
 *
 * Includes: new requests, completions, failures, expert activity, SLA compliance, revenue
 * Scheduled: Daily at 6:00 PM UTC (vercel.json)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendAdminDailySummary } from '@/lib/sendgrid';
import type { AdminDailySummaryStats } from '@/lib/types';

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    // Validate CRON_SECRET
    const cronSecret = request.headers.get('Authorization');
    const expectedSecret = process.env.CRON_SECRET;

    if (!cronSecret || !expectedSecret || cronSecret !== `Bearer ${expectedSecret}`) {
      return NextResponse.json(
        { error: 'Unauthorized: Invalid CRON_SECRET' },
        { status: 401 }
      );
    }

    const supabase = createAdminClient();

    // Get all admin users
    const { data: admins, error: adminsError } = await supabase
      .from('profiles')
      .select('id, email, full_name')
      .eq('role', 'admin')
      .not('email', 'is', null) as { data: { id: string; email: string; full_name: string | null }[] | null; error: any };

    if (adminsError || !admins || admins.length === 0) {
      console.error('No admins found or error:', adminsError);
      return NextResponse.json(
        { error: 'No admins found' },
        { status: 500 }
      );
    }

    // Calculate date range for today
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();
    const dateLabel = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    // New entities today (from requests created today)
    const { data: newRequestsData } = await supabase
      .from('requests')
      .select('request_entities(id)')
      .gte('created_at', todayISO) as { data: any[] | null; error: any };
    const newRequestsToday = (newRequestsData || []).reduce(
      (sum: number, r: any) => sum + (r.request_entities?.length || 0), 0
    );

    // Entities completed today
    const { count: completionsToday } = await supabase
      .from('request_entities')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'completed')
      .gte('completed_at', todayISO);

    // Entities failed today
    const { count: failuresToday } = await supabase
      .from('request_entities')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'failed')
      .gte('updated_at', todayISO);

    // Active entities (not completed or failed)
    const { count: activeRequests } = await supabase
      .from('request_entities')
      .select('*', { count: 'exact', head: true })
      .not('status', 'in', '("completed","failed")');

    // Expert completions today
    const { count: expertCompletionsToday } = await supabase
      .from('expert_assignments')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'completed')
      .gte('completed_at', todayISO);

    // Expert SLA compliance (from all completed assignments today)
    const { data: slaData } = await supabase
      .from('expert_assignments')
      .select('sla_met')
      .eq('status', 'completed')
      .gte('completed_at', todayISO) as { data: { sla_met: boolean | null }[] | null; error: any };

    let slaCompliance = 100;
    if (slaData && slaData.length > 0) {
      const slaMet = slaData.filter((s) => s.sla_met === true).length;
      slaCompliance = Math.round((slaMet / slaData.length) * 100);
    }

    // Entities completed today
    const { count: entitiesCompletedToday } = await supabase
      .from('request_entities')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'completed')
      .gte('completed_at', todayISO);

    // Entities pending
    const { count: entitiesPending } = await supabase
      .from('request_entities')
      .select('*', { count: 'exact', head: true })
      .not('status', 'in', '("completed","failed")');

    const stats: AdminDailySummaryStats = {
      new_requests_today: newRequestsToday || 0,
      completions_today: completionsToday || 0,
      failures_today: failuresToday || 0,
      expert_completions_today: expertCompletionsToday || 0,
      active_requests: activeRequests || 0,
      expert_sla_compliance: slaCompliance,
      total_entities_completed_today: entitiesCompletedToday || 0,
      total_entities_pending: entitiesPending || 0,
    };

    // Skip sending if there is zero activity today
    const hasActivity =
      stats.new_requests_today > 0 ||
      stats.completions_today > 0 ||
      stats.failures_today > 0 ||
      stats.expert_completions_today > 0;

    if (!hasActivity) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'No activity today',
        processedAt: new Date().toISOString(),
      });
    }

    // Send to all admins
    let emailsSent = 0;
    const errors: { email: string; error: string }[] = [];

    for (const admin of admins) {
      try {
        await sendAdminDailySummary(admin.email, stats, dateLabel);
        emailsSent++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.error(`Failed to send admin summary to ${admin.email}:`, msg);
        errors.push({ email: admin.email, error: msg });
      }
    }

    return NextResponse.json({
      success: true,
      emailsSent,
      totalAdmins: admins.length,
      stats,
      processedAt: new Date().toISOString(),
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Admin daily summary cron error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Cron job failed', details: errorMessage },
      { status: 500 }
    );
  }
}
