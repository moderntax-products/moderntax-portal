/**
 * Weekly Summary Cron Job (replaces daily nudge)
 * Sends weekly summary emails to processors (their own requests)
 * and managers (team-wide summary handled by manager-weekly-summary cron)
 * GET /api/cron/nudge
 *
 * Expected to be called by Vercel Cron with CRON_SECRET in headers
 * Scheduled: Every Monday
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendProcessorWeeklySummary } from '@/lib/sendgrid';

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

    // Get processors only (managers get their own weekly summary via manager-weekly-summary cron)
    const { data: processors, error: usersError } = await supabase
      .from('profiles')
      .select('id, email, full_name, role, client_id')
      .eq('role', 'processor')
      .not('email', 'is', null) as { data: { id: string; email: string; full_name: string | null; role: string; client_id: string | null }[] | null; error: any };

    if (usersError || !processors) {
      console.error('Failed to fetch processors:', usersError);
      return NextResponse.json(
        { error: 'Failed to fetch processors' },
        { status: 500 }
      );
    }

    // Get client names
    const clientIds = [...new Set(processors.map((p) => p.client_id).filter(Boolean))];
    const { data: clients } = await supabase
      .from('clients')
      .select('id, name')
      .in('id', clientIds as string[]) as { data: { id: string; name: string }[] | null; error: any };

    const clientMap: Record<string, string> = {};
    if (clients) {
      clients.forEach((c) => { clientMap[c.id] = c.name; });
    }

    let emailsSent = 0;
    const errors: { email: string; error: string }[] = [];

    // Process each processor
    for (const processor of processors) {
      try {
        // Get processor's own requests from the past week (with entities)
        const { data: weekRequests } = await supabase
          .from('requests')
          .select('id, status, created_at, completed_at, request_entities(id, status, completed_at, created_at)')
          .eq('requested_by', processor.id)
          .gte('created_at', weekAgoISO) as { data: any[] | null; error: any };

        // Get all processor requests that have entities completed this week
        const { data: allProcessorRequests } = await supabase
          .from('requests')
          .select('id, status, created_at, completed_at, request_entities(id, status, completed_at, created_at)')
          .eq('requested_by', processor.id) as { data: any[] | null; error: any };

        // Count at entity level
        const entitiesSubmitted = (weekRequests || []).reduce(
          (sum: number, r: any) => sum + (r.request_entities?.length || 0), 0
        );

        const allEntities = (allProcessorRequests || []).flatMap((r: any) =>
          (r.request_entities || []).map((e: any) => ({ ...e, request_created_at: r.created_at }))
        );
        const entitiesCompleted = allEntities.filter(
          (e: any) => e.status === 'completed' && e.completed_at && e.completed_at >= weekAgoISO
        ).length;
        const entitiesPending = (weekRequests || []).flatMap((r: any) => r.request_entities || [])
          .filter((e: any) => e.status !== 'completed' && e.status !== 'failed').length;

        // Skip if zero activity
        if (entitiesSubmitted === 0 && entitiesCompleted === 0) {
          continue;
        }

        // Calculate avg turnaround per entity
        let avgTurnaroundHours: number | null = null;
        const completedEntities = allEntities.filter(
          (e: any) => e.status === 'completed' && e.completed_at && e.completed_at >= weekAgoISO
        );
        if (completedEntities.length > 0) {
          const turnarounds = completedEntities
            .map((e: any) => {
              const created = new Date(e.request_created_at || e.created_at).getTime();
              const done = new Date(e.completed_at).getTime();
              return (done - created) / (1000 * 60 * 60);
            });
          if (turnarounds.length > 0) {
            avgTurnaroundHours = turnarounds.reduce((a, b) => a + b, 0) / turnarounds.length;
          }
        }

        const clientName = processor.client_id ? (clientMap[processor.client_id] || 'Your Organization') : 'Your Organization';

        await sendProcessorWeeklySummary(
          processor.email,
          processor.full_name || 'Team Member',
          clientName,
          {
            requests_submitted: entitiesSubmitted,
            requests_completed: entitiesCompleted,
            requests_pending: entitiesPending,
            avg_turnaround_hours: avgTurnaroundHours,
          },
          weekRange
        );
        emailsSent++;
      } catch (userError) {
        const errorMessage = userError instanceof Error ? userError.message : 'Unknown error';
        console.error(`Error processing processor ${processor.email}:`, errorMessage);
        errors.push({ email: processor.email, error: errorMessage });
      }
    }

    return NextResponse.json({
      success: true,
      emailsSent,
      totalProcessors: processors.length,
      processedAt: new Date().toISOString(),
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Cron job error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Cron job failed', details: errorMessage },
      { status: 500 }
    );
  }
}
