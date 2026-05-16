/**
 * Admin: paginated/filtered batch list for the /admin/batches page.
 *
 * GET /api/admin/batch/list?status=pending_acceptance,accepted&limit=50
 *
 * Returns each batch decorated with:
 *   · expert email + name
 *   · entities[] (id, name, client, loan, status)
 *   · countdown deadlines (server time included for client clock-skew correction)
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';

const ALL_STATUSES = [
  'pending_acceptance', 'accepted', 'declined', 'expired', 'completed', 'cancelled',
] as const;

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: caller } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (caller?.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 });

  const url = request.nextUrl;
  const statusParam = url.searchParams.get('status');
  const statuses = statusParam
    ? statusParam.split(',').filter(s => (ALL_STATUSES as readonly string[]).includes(s))
    : (ALL_STATUSES as readonly string[]).slice();
  const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);

  const admin = createAdminClient();

  const { data: batches } = await admin
    .from('assignment_batches')
    .select(`
      id, status, offered_at, acceptance_deadline, accepted_at,
      declined_at, expired_at, cancelled_at, completion_deadline, completed_at,
      decline_reason, notes,
      expert:profiles!assignment_batches_expert_id_fkey(id, email, full_name),
      offerer:profiles!assignment_batches_offered_by_fkey(id, email, full_name)
    `)
    .in('status', statuses)
    .order('offered_at', { ascending: false })
    .limit(limit) as { data: any[] | null };

  // Pull entities for these batches (one trip)
  const batchIds = (batches || []).map(b => b.id);
  let assignmentsByBatch: Record<string, any[]> = {};
  if (batchIds.length > 0) {
    const { data: assns } = await admin
      .from('expert_assignments')
      .select(`
        id, status, batch_id,
        request_entities(id, entity_name, form_type, status, request_id, requests(loan_number, clients(name)))
      `)
      .in('batch_id', batchIds) as { data: any[] | null };
    for (const a of assns || []) {
      const arr = assignmentsByBatch[a.batch_id] || [];
      arr.push({
        assignmentId: a.id,
        assignmentStatus: a.status,
        entityId: a.request_entities?.id,
        entityName: a.request_entities?.entity_name,
        entityStatus: a.request_entities?.status,
        formType: a.request_entities?.form_type,
        loanNumber: a.request_entities?.requests?.loan_number || null,
        clientName: a.request_entities?.requests?.clients?.name || null,
      });
      assignmentsByBatch[a.batch_id] = arr;
    }
  }

  const decorated = (batches || []).map((b: any) => ({
    id: b.id,
    status: b.status,
    offeredAt: b.offered_at,
    acceptanceDeadline: b.acceptance_deadline,
    acceptedAt: b.accepted_at,
    declinedAt: b.declined_at,
    expiredAt: b.expired_at,
    cancelledAt: b.cancelled_at,
    completionDeadline: b.completion_deadline,
    completedAt: b.completed_at,
    declineReason: b.decline_reason,
    notes: b.notes,
    expert: b.expert ? { id: b.expert.id, email: b.expert.email, name: b.expert.full_name } : null,
    offerer: b.offerer ? { email: b.offerer.email, name: b.offerer.full_name } : null,
    entities: assignmentsByBatch[b.id] || [],
  }));

  return NextResponse.json({ serverTime: new Date().toISOString(), batches: decorated });
}
