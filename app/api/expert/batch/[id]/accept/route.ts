/**
 * Expert accepts a pending batch.
 *
 * POST /api/expert/batch/[id]/accept
 *   - Validates that the caller IS the batch's expert
 *   - Regenerates 8821 PDFs for every entity in the batch using the
 *     expert's CAF/PTIN/phone
 *   - Advances batch → accepted, assignments → assigned, completion
 *     deadline = now + 24h, expert_clock_started_at set
 *
 * Returns: { success, batch, regenerated: [...], errors: [...] }
 * Partial regen success is acceptable — admin can fix failures via the
 * existing Regenerate8821Button.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { acceptBatch } from '@/lib/assignment-batch';

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
  const result = await acceptBatch(admin, params.id, user.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, ...(result.errors ? { errors: result.errors } : {}) }, { status: 400 });
  }

  await logAuditFromRequest(admin, request, {
    action: 'expert_assigned',
    userId: user.id,
    userEmail: user.email || '',
    resourceType: 'assignment_batch',
    resourceId: params.id,
    details: {
      action_kind: 'batch_accepted',
      regenerated_count: (result.regenerated || []).length,
      regen_errors_count: (result.errors || []).length,
    },
  });

  return NextResponse.json({
    success: true,
    batch: result.batch,
    regenerated: result.regenerated || [],
    errors: result.errors || [],
  });
}
