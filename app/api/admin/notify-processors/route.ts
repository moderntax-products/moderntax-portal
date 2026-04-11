/**
 * Notify Processors — Backlog Status Email
 * POST /api/admin/notify-processors
 *
 * Sends each processor/manager a personalized email showing their pending requests,
 * entity-level status, expert assignments, and timeline expectations.
 *
 * Can be triggered manually from admin dashboard or via cron.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { sendProcessorBacklogNotification } from '@/lib/sendgrid';

export async function POST(request: NextRequest) {
  try {
    // Auth: admin only (via session) or cron secret
    const authHeader = request.headers.get('authorization');
    const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;

    if (!isCron) {
      const cookieStore = await cookies();
      const supabase = createServerRouteClient(cookieStore);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      }
      const adminSupabase = createAdminClient();
      const { data: profile } = await adminSupabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();
      if (!profile || (profile as any).role !== 'admin') {
        return NextResponse.json({ error: 'Admin only' }, { status: 403 });
      }
    }

    const adminSupabase = createAdminClient();
    const now = new Date();

    // Get all incomplete requests with entities, client info, and submitter info
    const { data: requests, error: reqError } = await adminSupabase
      .from('requests')
      .select(`
        id, loan_number, status, created_at, client_id, requested_by,
        clients(id, name),
        profiles!requests_requested_by_fkey(id, full_name, email, role)
      `)
      .not('status', 'in', '("completed","failed","cancelled")')
      .order('created_at', { ascending: true }) as { data: any[] | null; error: any };

    if (reqError || !requests || requests.length === 0) {
      return NextResponse.json({
        success: true,
        sent: 0,
        message: reqError ? 'Query failed' : 'No pending requests',
      });
    }

    // Get entities for these requests
    const requestIds = requests.map((r: any) => r.id);
    const { data: entities } = await adminSupabase
      .from('request_entities')
      .select('id, request_id, entity_name, status')
      .in('request_id', requestIds) as { data: any[] | null; error: any };

    // Get expert assignments
    const entityIds = (entities || []).map((e: any) => e.id);
    const { data: assignments } = await adminSupabase
      .from('expert_assignments')
      .select('entity_id, expert_id, status, profiles!expert_assignments_expert_id_fkey(full_name)')
      .in('entity_id', entityIds.length > 0 ? entityIds : ['__none__'])
      .in('status', ['assigned', 'in_progress']) as { data: any[] | null; error: any };

    const assignmentMap = new Map<string, any>();
    (assignments || []).forEach((a: any) => assignmentMap.set(a.entity_id, a));

    // Group entities by request
    const entityMap = new Map<string, any[]>();
    (entities || []).forEach((e: any) => {
      if (!entityMap.has(e.request_id)) entityMap.set(e.request_id, []);
      entityMap.get(e.request_id)!.push(e);
    });

    // Group requests by processor (requested_by)
    const processorRequests = new Map<string, { profile: any; clientName: string; requests: any[] }>();

    for (const req of requests) {
      const processorId = req.requested_by;
      if (!processorId) continue;

      const profile = req.profiles;
      if (!profile?.email) continue;

      // Skip admin-submitted requests (ClearFirm bot, etc.) — only notify processors/managers
      if (profile.role === 'admin') continue;

      if (!processorRequests.has(processorId)) {
        processorRequests.set(processorId, {
          profile,
          clientName: req.clients?.name || 'Unknown',
          requests: [],
        });
      }

      const reqEntities = entityMap.get(req.id) || [];
      const pendingEntities = reqEntities.filter((e: any) => !['completed', 'failed'].includes(e.status));

      if (pendingEntities.length === 0) continue; // All entities done for this request

      const createdAt = new Date(req.created_at);
      const ageHours = Math.round((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60));
      const ageDays = Math.floor(ageHours / 24);
      const ageDisplay = ageDays > 0 ? `${ageDays}d ${ageHours % 24}h` : `${ageHours}h`;

      const entitiesWithBlockers = pendingEntities.map((e: any) => {
        const assignment = assignmentMap.get(e.id);
        let blocker = 'pending';
        if (e.status === '8821_sent') blocker = 'awaiting_signature';
        else if (e.status === 'irs_queue' && !assignment) blocker = 'needs_expert';
        else if (e.status === 'irs_queue') blocker = 'irs_queue';
        else if (e.status === 'processing') blocker = 'processing';

        return {
          name: e.entity_name,
          status: e.status,
          expertName: assignment?.profiles?.full_name || null,
          blocker,
        };
      });

      processorRequests.get(processorId)!.requests.push({
        loanNumber: req.loan_number || req.id.slice(0, 8),
        status: req.status,
        ageDisplay,
        ageDays,
        entities: entitiesWithBlockers,
      });
    }

    // Send emails per processor
    let sent = 0;
    for (const [, data] of processorRequests) {
      if (data.requests.length === 0) continue;

      const allEntities = data.requests.flatMap((r) => r.entities);
      const summary = {
        totalPending: allEntities.length,
        awaitingSignature: allEntities.filter((e) => e.blocker === 'awaiting_signature').length,
        inIrsQueue: allEntities.filter((e) => e.blocker === 'irs_queue').length,
        unassigned: allEntities.filter((e) => e.blocker === 'needs_expert').length,
        staleCount: data.requests.filter((r) => r.ageDays >= 3).length,
      };

      await sendProcessorBacklogNotification(
        data.profile.email,
        data.profile.full_name || 'there',
        data.clientName,
        data.requests,
        summary
      );
      sent++;
    }

    return NextResponse.json({
      success: true,
      sent,
      processors: Array.from(processorRequests.entries()).map(([_id, data]) => ({
        name: data.profile.full_name,
        email: data.profile.email,
        client: data.clientName,
        pendingRequests: data.requests.length,
      })),
    });
  } catch (error) {
    console.error('Notify processors error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
