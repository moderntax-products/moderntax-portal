/**
 * Admin: cancel an active batch offer.
 *
 * Use cases:
 *   · Stale pending offer that should be rerouted (admin override)
 *   · Accepted batch where the expert is stuck — admin takes it back
 *     to re-offer
 *
 * POST /api/admin/expert/batch/[id]/cancel
 *   Body: { reason?: string }
 *
 * Releases all per-entity assignments back to the pool. The auto-batch
 * cron will re-offer them within ~30 min.
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

  const { data: caller } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (caller?.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 });

  const parsed = await parseJsonBodyOrRespond<{ reason?: string }>(request, 8 * 1024);
  const reason = parsed instanceof NextResponse ? '' : (parsed?.reason || '').slice(0, 500);

  const admin = createAdminClient();
  const result = await releaseBatch(admin, params.id, 'cancelled', {
    actorId: user.id,
    declineReason: reason || 'Cancelled by admin',
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
      action_kind: 'batch_cancelled_by_admin',
      reason: reason || null,
      entities_returned: result.entitiesReturned || 0,
    },
  });

  return NextResponse.json({ success: true, entitiesReturned: result.entitiesReturned });
}
