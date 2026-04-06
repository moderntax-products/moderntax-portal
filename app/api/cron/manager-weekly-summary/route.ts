/**
 * Manager Weekly Summary Cron Job
 * Sends weekly team performance summary to all managers
 * GET /api/cron/manager-weekly-summary
 *
 * Includes: team requests, completions, failures, per-processor breakdown, avg turnaround
 * Scheduled: Every Monday at 2:00 PM UTC (vercel.json)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendManagerWeeklySummary } from '@/lib/sendgrid';
import type { ManagerWeeklySummaryStats } from '@/lib/types';

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

    // Calculate date range for last 7 days
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const weekAgoISO = weekAgo.toISOString();
    const weekRange = `${weekAgo.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    // Get all managers with their client info
    const { data: managers, error: managersError } = await supabase
      .from('profiles')
      .select('id, email, full_name, client_id')
      .eq('role', 'manager')
      .not('email', 'is', null)
      .not('client_id', 'is', null) as { data: { id: string; email: string; full_name: string | null; client_id: string }[] | null; error: any };

    if (managersError || !managers || managers.length === 0) {
      console.log('No managers found or error:', managersError);
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'No managers found',
        processedAt: new Date().toISOString(),
      });
    }

    // Get unique client IDs from managers
    const clientIds = [...new Set(managers.map((m) => m.client_id))];

    // Get client names
    const { data: clients } = await supabase
      .from('clients')
      .select('id, name')
      .in('id', clientIds) as { data: { id: string; name: string }[] | null; error: any };

    const clientMap: Record<string, string> = {};
    if (clients) {
      clients.forEach((c) => { clientMap[c.id] = c.name; });
    }

    let emailsSent = 0;
    const errors: { email: string; error: string }[] = [];

    // Process each manager
    for (const manager of managers) {
      try {
        const clientId = manager.client_id;
        const clientName = clientMap[clientId] || 'Your Organization';

        // Get all requests for this client in the past week (with entities)
        const { data: weekRequests } = await supabase
          .from('requests')
          .select('id, status, requested_by, created_at, completed_at, request_entities(id, status, completed_at, created_at)')
          .eq('client_id', clientId)
          .gte('created_at', weekAgoISO) as { data: any[] | null; error: any };

        // Get requests with entities completed this week (may have been created earlier)
        const { data: requestsWithCompletions } = await supabase
          .from('requests')
          .select('id, status, requested_by, created_at, completed_at, request_entities(id, status, completed_at, created_at)')
          .eq('client_id', clientId) as { data: any[] | null; error: any };

        // Count entities submitted this week (from requests created this week)
        const entitiesSubmitted = (weekRequests || []).reduce(
          (sum: number, r: any) => sum + (r.request_entities?.length || 0), 0
        );

        // Count entities completed this week (across all requests, by entity completed_at)
        const allClientEntities = (requestsWithCompletions || []).flatMap((r: any) =>
          (r.request_entities || []).map((e: any) => ({ ...e, requested_by: r.requested_by, request_created_at: r.created_at }))
        );
        const entitiesCompletedThisWeek = allClientEntities.filter(
          (e: any) => e.status === 'completed' && e.completed_at && e.completed_at >= weekAgoISO
        );
        const entitiesFailedThisWeek = allClientEntities.filter(
          (e: any) => e.status === 'failed' && e.completed_at && e.completed_at >= weekAgoISO
        );

        // Calculate average turnaround time (per entity, not per request)
        let avgTurnaroundHours: number | null = null;
        if (entitiesCompletedThisWeek.length > 0) {
          const turnarounds = entitiesCompletedThisWeek
            .filter((e: any) => e.completed_at && e.created_at)
            .map((e: any) => {
              const created = new Date(e.request_created_at || e.created_at).getTime();
              const completed = new Date(e.completed_at).getTime();
              return (completed - created) / (1000 * 60 * 60);
            });

          if (turnarounds.length > 0) {
            avgTurnaroundHours = turnarounds.reduce((a, b) => a + b, 0) / turnarounds.length;
          }
        }

        // Get per-processor breakdown (entity-level)
        const { data: teamMembers } = await supabase
          .from('profiles')
          .select('id, full_name, email')
          .eq('client_id', clientId)
          .in('role', ['processor', 'manager']) as { data: { id: string; full_name: string | null; email: string }[] | null; error: any };

        const processorBreakdown: { name: string; submitted: number; completed: number }[] = [];

        if (teamMembers) {
          for (const member of teamMembers) {
            // Entities submitted this week by this member
            const submitted = (weekRequests || [])
              .filter((r: any) => r.requested_by === member.id)
              .reduce((sum: number, r: any) => sum + (r.request_entities?.length || 0), 0);
            // Entities completed this week by this member
            const completed = entitiesCompletedThisWeek
              .filter((e: any) => e.requested_by === member.id).length;

            if (submitted > 0 || completed > 0) {
              processorBreakdown.push({
                name: member.full_name || member.email,
                submitted,
                completed,
              });
            }
          }
        }

        // Sort by submitted descending
        processorBreakdown.sort((a, b) => b.submitted - a.submitted);

        const stats: ManagerWeeklySummaryStats = {
          requests_submitted: entitiesSubmitted,
          requests_completed: entitiesCompletedThisWeek.length,
          requests_failed: entitiesFailedThisWeek.length,
          entities_completed: entitiesCompletedThisWeek.length,
          avg_turnaround_hours: avgTurnaroundHours,
          processor_breakdown: processorBreakdown,
        };

        // Skip if zero activity this week
        if (stats.requests_submitted === 0 && stats.requests_completed === 0 && stats.requests_failed === 0) {
          continue;
        }

        await sendManagerWeeklySummary(
          manager.email,
          manager.full_name || 'Manager',
          clientName,
          stats,
          weekRange
        );
        emailsSent++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.error(`Failed to send weekly summary to ${manager.email}:`, msg);
        errors.push({ email: manager.email, error: msg });
      }
    }

    return NextResponse.json({
      success: true,
      emailsSent,
      totalManagers: managers.length,
      processedAt: new Date().toISOString(),
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Manager weekly summary cron error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Cron job failed', details: errorMessage },
      { status: 500 }
    );
  }
}
