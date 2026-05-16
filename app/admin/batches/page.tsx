/**
 * Admin: live dashboard of all expert batches.
 *
 * URL: /admin/batches
 *
 * Server renders the initial state for fast first paint, then the
 * client component polls /api/admin/batch/list every 30s for updates.
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';
import { AdminBatchesView } from '@/components/AdminBatchesView';

export const dynamic = 'force-dynamic';

export default async function AdminBatchesPage() {
  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (profile?.role !== 'admin') redirect('/');

  const admin = createAdminClient();

  // Initial batches — same shape as the polling API for hand-off
  const { data: batches } = await admin
    .from('assignment_batches')
    .select(`
      id, status, offered_at, acceptance_deadline, accepted_at,
      declined_at, expired_at, cancelled_at, completion_deadline, completed_at,
      decline_reason, notes,
      expert:profiles!assignment_batches_expert_id_fkey(id, email, full_name),
      offerer:profiles!assignment_batches_offered_by_fkey(id, email, full_name)
    `)
    .order('offered_at', { ascending: false })
    .limit(100) as { data: any[] | null };

  const batchIds = (batches || []).map(b => b.id);
  const assignmentsByBatch: Record<string, any[]> = {};
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
        entityId: (a.request_entities as any)?.id,
        entityName: (a.request_entities as any)?.entity_name,
        entityStatus: (a.request_entities as any)?.status,
        formType: (a.request_entities as any)?.form_type,
        loanNumber: (a.request_entities as any)?.requests?.loan_number || null,
        clientName: (a.request_entities as any)?.requests?.clients?.name || null,
      });
      assignmentsByBatch[a.batch_id] = arr;
    }
  }

  const initialBatches = (batches || []).map((b: any) => ({
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

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <Link href="/admin" className="text-sm text-blue-600 hover:text-blue-800 mb-2 inline-block">← Admin Dashboard</Link>
          <h1 className="text-2xl font-bold text-gray-900">Expert Batches</h1>
          <p className="text-sm text-gray-600 mt-1">
            Live view of all batch offers. Pending offers expire after 30 minutes; accepted batches must complete within 24 hours.
            The auto-batcher cron runs every 30 min.
          </p>
        </div>
        <AdminBatchesView initialBatches={initialBatches} initialServerTime={new Date().toISOString()} />
      </div>
    </div>
  );
}
