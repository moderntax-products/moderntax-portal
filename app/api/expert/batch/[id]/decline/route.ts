/**
 * Expert declines a pending batch. Releases all entities back to the pool.
 *
 * POST /api/expert/batch/[id]/decline
 *   Body: { reason?: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { releaseBatch } from '@/lib/assignment-batch';
import { parseJsonBodyOrRespond } from '@/lib/request-body';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (!profile || !['expert', 'admin'].includes(profile.role)) {
    return NextResponse.json({ error: 'Expert or admin role required' }, { status: 403 });
  }

  const admin = createAdminClient();

  // Verify the batch is offered to this caller (or caller is admin)
  const { data: batch } = await admin
    .from('assignment_batches').select('id, expert_id, status').eq('id', params.id).single() as { data: any };
  if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
  if (profile.role !== 'admin' && batch.expert_id !== user.id) {
    return NextResponse.json({ error: 'This batch is not offered to you' }, { status: 403 });
  }

  const parsed = await parseJsonBodyOrRespond<{ reason?: string }>(request, 16 * 1024);
  // Decline reason is optional — empty body is also fine
  const reason = parsed instanceof NextResponse ? '' : (parsed?.reason || '').slice(0, 500);

  const result = await releaseBatch(admin, params.id, 'declined', {
    actorId: user.id,
    declineReason: reason,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  await logAuditFromRequest(admin, request, {
    action: 'expert_assigned',
    userId: user.id,
    userEmail: user.email || '',
    resourceType: 'assignment_batch',
    resourceId: params.id,
    details: {
      action_kind: 'batch_declined',
      reason: reason || null,
      entities_returned: result.entitiesReturned || 0,
    },
  });

  return NextResponse.json({ success: true, entitiesReturned: result.entitiesReturned });
}
