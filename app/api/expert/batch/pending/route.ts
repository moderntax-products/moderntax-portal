/**
 * GET /api/expert/batch/pending
 *
 * Returns the calling expert's currently-pending batch offer, if any —
 * along with the entities in it for the dashboard offer card to render.
 * Status filter: pending_acceptance OR accepted (so the same endpoint
 * powers both "incoming offer" and "active in-progress batch" UI states).
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';

export async function GET() {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();

  const { data: batch } = await admin
    .from('assignment_batches')
    .select('id, status, offered_at, acceptance_deadline, accepted_at, completion_deadline, notes')
    .eq('expert_id', user.id)
    .in('status', ['pending_acceptance', 'accepted'])
    .order('offered_at', { ascending: false })
    .limit(1)
    .maybeSingle() as { data: any };

  if (!batch) return NextResponse.json({ batch: null });

  // Pull entities for this batch via the assignments → entities join
  const { data: assignments } = await admin
    .from('expert_assignments')
    .select(`
      id,
      status,
      request_entities(
        id, entity_name, tid_kind, form_type, years,
        request_id,
        requests(loan_number, clients(name))
      )
    `)
    .eq('batch_id', batch.id) as { data: any[] | null };

  const entities = (assignments || []).map(a => ({
    assignmentId: a.id,
    assignmentStatus: a.status,
    entityId: a.request_entities?.id,
    entityName: a.request_entities?.entity_name,
    tidKind: a.request_entities?.tid_kind,
    formType: a.request_entities?.form_type,
    years: a.request_entities?.years,
    loanNumber: a.request_entities?.requests?.loan_number,
    clientName: a.request_entities?.requests?.clients?.name,
  }));

  return NextResponse.json({ batch, entities });
}
