/**
 * Daily Nudge Cron Job
 * Sends daily summary emails to users with pending requests
 * GET /api/cron/nudge
 *
 * Expected to be called by Vercel Cron with CRON_SECRET in headers
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase';
import { sendDailyNudge } from '@/lib/sendgrid';
import type { DailyNudgeStats } from '@/lib/types';

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

    // Get all active users (who have created requests)
    const { data: users, error: usersError } = await supabase
      .from('profiles')
      .select('id, email, full_name')
      .not('email', 'is', null);

    if (usersError || !users) {
      console.error('Failed to fetch users:', usersError);
      return NextResponse.json(
        { error: 'Failed to fetch users' },
        { status: 500 }
      );
    }

    let emailsSent = 0;
    const errors: { email: string; error: string }[] = [];

    // Process each user
    for (const user of users) {
      try {
        // Get user's request stats
        const { data: requests, error: requestsError } = await supabase
          .from('requests')
          .select('status, created_at, completed_at')
          .eq('requested_by', user.id);

        if (requestsError || !requests) {
          console.error(`Failed to fetch requests for user ${user.id}:`, requestsError);
          continue;
        }

        if (requests.length === 0) {
          // Skip users with no requests
          continue;
        }

        // Calculate stats
        const now = new Date();
        const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const today = new Date(now);
        today.setHours(0, 0, 0, 0);

        const pendingCount = requests.filter(
          (r) => r.status !== 'completed' && r.status !== 'failed'
        ).length;

        const inProgressCount = requests.filter(
          (r) => r.status !== 'submitted' && r.status !== 'completed' && r.status !== 'failed'
        ).length;

        const completedThisWeekCount = requests.filter((r) => {
          if (r.status !== 'completed' || !r.completed_at) return false;
          return new Date(r.completed_at) >= oneWeekAgo;
        }).length;

        // Calculate oldest pending request
        const pendingRequests = requests.filter(
          (r) => r.status !== 'completed' && r.status !== 'failed'
        );
        let oldestPendingDays: number | null = null;

        if (pendingRequests.length > 0) {
          const oldestPending = pendingRequests.reduce((oldest, current) => {
            const oldestDate = new Date(oldest.created_at);
            const currentDate = new Date(current.created_at);
            return currentDate < oldestDate ? current : oldest;
          });

          oldestPendingDays = Math.floor(
            (now.getTime() - new Date(oldestPending.created_at).getTime()) /
              (24 * 60 * 60 * 1000)
          );
        }

        const stats: DailyNudgeStats = {
          pending_count: pendingCount,
          completed_count: completedThisWeekCount,
          in_progress_count: inProgressCount,
          oldest_pending_days: oldestPendingDays,
        };

        // Send email
        await sendDailyNudge(user.email, stats);
        emailsSent++;
      } catch (userError) {
        const errorMessage = userError instanceof Error ? userError.message : 'Unknown error';
        console.error(`Error processing user ${user.email}:`, errorMessage);
        errors.push({
          email: user.email,
          error: errorMessage,
        });
      }
    }

    // Return summary
    return NextResponse.json(
      {
        success: true,
        emailsSent,
        totalUsers: users.length,
        processedAt: new Date().toISOString(),
        errors: errors.length > 0 ? errors : undefined,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Cron job error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Cron job failed', details: errorMessage },
      { status: 500 }
    );
  }
}
