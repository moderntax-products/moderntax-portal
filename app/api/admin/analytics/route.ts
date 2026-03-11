/**
 * Admin Analytics API
 *
 * GET /api/admin/analytics?days=30
 *
 * Returns aggregated analytics data for the admin dashboard.
 * Admin-only access.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    // Verify admin
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!profile || profile.role !== 'admin') {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 });
    }

    // Parse date range
    const days = parseInt(request.nextUrl.searchParams.get('days') || '30');
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const adminClient = createAdminClient();

    // Fetch analytics data in parallel
    const [summaryRes, topPagesRes, userActivityRes, signupsRes] =
      await Promise.all([
        // Overall summary
        adminClient
          .from('analytics_events')
          .select('event_type, user_id, session_id', { count: 'exact' })
          .gte('created_at', startDate.toISOString()),

        // Top pages
        adminClient
          .from('analytics_events')
          .select('page_path')
          .eq('event_type', 'page_view')
          .gte('created_at', startDate.toISOString())
          .not('page_path', 'is', null)
          .order('created_at', { ascending: false })
          .limit(500),

        // Active users (recent logins)
        adminClient
          .from('analytics_events')
          .select('user_email, user_role, created_at')
          .eq('event_type', 'login')
          .gte('created_at', startDate.toISOString())
          .order('created_at', { ascending: false })
          .limit(100),

        // Signups
        adminClient
          .from('analytics_events')
          .select('user_email, metadata, created_at')
          .eq('event_type', 'signup')
          .gte('created_at', startDate.toISOString())
          .order('created_at', { ascending: false })
          .limit(50),
      ]);

    // Aggregate page view counts
    const pageViewCounts: Record<string, number> = {};
    if (topPagesRes.data) {
      for (const row of topPagesRes.data) {
        const path = (row as any).page_path;
        if (path) {
          pageViewCounts[path] = (pageViewCounts[path] || 0) + 1;
        }
      }
    }
    const topPages = Object.entries(pageViewCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 15)
      .map(([path, views]) => ({ path, views }));

    // Count events by type
    const eventTypeCounts: Record<string, number> = {};
    const uniqueUsers = new Set<string>();
    const uniqueSessions = new Set<string>();

    if (summaryRes.data) {
      for (const row of summaryRes.data) {
        const r = row as any;
        eventTypeCounts[r.event_type] = (eventTypeCounts[r.event_type] || 0) + 1;
        if (r.user_id) uniqueUsers.add(r.user_id);
        if (r.session_id) uniqueSessions.add(r.session_id);
      }
    }

    // Recent logins
    const recentLogins = (userActivityRes.data || []).reduce(
      (acc: any[], row: any) => {
        if (!acc.find((r: any) => r.user_email === row.user_email)) {
          acc.push({
            email: row.user_email,
            role: row.user_role,
            lastLogin: row.created_at,
          });
        }
        return acc;
      },
      []
    ).slice(0, 20);

    return NextResponse.json({
      period: { days, startDate: startDate.toISOString() },
      summary: {
        totalEvents: summaryRes.count || 0,
        uniqueUsers: uniqueUsers.size,
        uniqueSessions: uniqueSessions.size,
        pageViews: eventTypeCounts['page_view'] || 0,
        logins: eventTypeCounts['login'] || 0,
        signups: eventTypeCounts['signup'] || 0,
        requestsCreated: eventTypeCounts['request_created'] || 0,
        transcriptsDownloaded: eventTypeCounts['transcript_downloaded'] || 0,
      },
      topPages,
      recentLogins,
      recentSignups: (signupsRes.data || []).map((r: any) => ({
        email: r.user_email,
        metadata: r.metadata,
        date: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[analytics] API error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
