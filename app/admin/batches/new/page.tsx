/**
 * Admin: create a new expert batch.
 *
 * URL: /admin/batches/new
 *
 * Server component loads:
 *   · All entities in 8821_signed status with NO active assignment
 *     (the pool of work eligible to be batched)
 *   · All experts with complete designee creds
 *     (decorated with whether they currently have a pending/accepted batch)
 *
 * The client form lets admin pick 3-5 entities + an expert + offer the
 * batch (POST /api/admin/expert/batch/create).
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';
import { validateExpertDesigneeCreds } from '@/lib/8821-pdf';
import { AdminBatchCreateForm } from '@/components/AdminBatchCreateForm';

export const dynamic = 'force-dynamic';

export default async function AdminBatchCreatePage() {
  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (profile?.role !== 'admin') redirect('/');

  const admin = createAdminClient();

  // Eligible entities: 8821_signed AND no active assignment (the batch pool)
  const { data: eligibleEntities } = await admin
    .from('request_entities')
    .select(`
      id, entity_name, tid_kind, form_type, years, updated_at,
      requests(loan_number, clients(name))
    `)
    .eq('status', '8821_signed')
    .not('signed_8821_url', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(50) as { data: any[] | null };

  // Filter out entities that have an active assignment
  const { data: activeAssns } = await admin
    .from('expert_assignments')
    .select('entity_id')
    .in('status', ['pending_acceptance', 'assigned', 'in_progress']);
  const blockedIds = new Set((activeAssns || []).map((a: any) => a.entity_id));
  const pool = (eligibleEntities || []).filter(e => !blockedIds.has(e.id));

  // Experts + their current batch status
  const { data: experts } = await admin
    .from('profiles')
    .select('id, email, full_name, caf_number, ptin, phone_number, fax_number, address, city, state, zip_code')
    .eq('role', 'expert')
    .order('full_name', { ascending: true }) as { data: any[] | null };

  const { data: currentBatches } = await admin
    .from('assignment_batches')
    .select('expert_id, status')
    .in('status', ['pending_acceptance', 'accepted']);
  const busyExperts = new Map<string, string>(
    (currentBatches || []).map((b: any) => [b.expert_id, b.status]),
  );

  const expertsDecorated = (experts || []).map((e: any) => {
    const missing = validateExpertDesigneeCreds(e);
    return {
      id: e.id,
      email: e.email,
      fullName: e.full_name,
      credsComplete: missing.length === 0,
      missingFields: missing,
      currentBatchStatus: busyExperts.get(e.id) || null,
    };
  });

  const poolFormatted = pool.map(e => ({
    id: e.id,
    entityName: e.entity_name,
    tidKind: e.tid_kind,
    formType: e.form_type,
    years: e.years || [],
    waitingSinceIso: e.updated_at,
    loanNumber: e.requests?.loan_number || null,
    clientName: e.requests?.clients?.name || null,
  }));

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <Link href="/admin" className="text-sm text-blue-600 hover:text-blue-800 mb-2 inline-block">← Admin Dashboard</Link>
          <h1 className="text-2xl font-bold text-gray-900">Offer New Batch to Expert</h1>
          <p className="text-sm text-gray-600 mt-1">
            Select 3–5 entities + an available expert. Expert has 30 minutes to accept; on accept,
            8821 PDFs are regenerated with their credentials and they have 24 hours to complete.
          </p>
        </div>

        <AdminBatchCreateForm
          pool={poolFormatted}
          experts={expertsDecorated}
        />
      </div>
    </div>
  );
}
