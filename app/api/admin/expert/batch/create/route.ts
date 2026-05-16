/**
 * Admin: create a batch of 3-5 entity assignments offered to an expert.
 * The expert gets 30 minutes to accept; on accept the 8821 PDFs are
 * regenerated with their CAF/PTIN/phone.
 *
 * POST /api/admin/expert/batch/create
 *   Body: { expertId: string, entityIds: string[] (3-5), notes?: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { sendExpertAssignmentNotification } from '@/lib/sendgrid';
import { createBatch } from '@/lib/assignment-batch';
import { parseJsonBodyOrRespond } from '@/lib/request-body';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: caller } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (caller?.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 });

  const parsed = await parseJsonBodyOrRespond<{ expertId?: string; entityIds?: string[]; notes?: string }>(request, 32 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const { expertId, entityIds, notes } = parsed;
  if (!expertId || !Array.isArray(entityIds) || entityIds.length === 0) {
    return NextResponse.json({ error: 'expertId + entityIds[] required' }, { status: 400 });
  }

  const admin = createAdminClient();
  const result = await createBatch(admin, { expertId, entityIds, offeredBy: user.id, notes });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, ...(result.details ? { details: result.details } : {}) }, { status: 400 });
  }

  // Audit
  await logAuditFromRequest(admin, request, {
    action: 'expert_assigned',
    userId: user.id,
    userEmail: user.email || '',
    resourceType: 'assignment_batch',
    resourceId: result.batch!.id,
    details: {
      action_kind: 'batch_created',
      expert_id: expertId,
      entity_count: entityIds.length,
      acceptance_deadline: result.batch!.acceptance_deadline,
    },
  });

  // Notify expert (best-effort)
  try {
    const { data: expert } = await admin.from('profiles').select('email').eq('id', expertId).single() as { data: { email: string } | null };
    const { data: entities } = await admin.from('request_entities').select('entity_name').in('id', entityIds);
    if (expert?.email) {
      await sendExpertAssignmentNotification(
        expert.email,
        (entities || []).map((e: any) => e.entity_name),
        entityIds.length,
      );
    }
  } catch (notifyErr) {
    console.warn('[batch/create] notification failed (non-fatal):', notifyErr);
  }

  return NextResponse.json({ success: true, batch: result.batch });
}
