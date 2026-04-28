/**
 * /admin/pending-signups — admin queue for new sign-ups awaiting approval.
 *
 * Shows everyone with profiles.approval_status='pending', sorted oldest
 * first (so the longest-waiting prospect is acted on first). Each row
 * shows their qualification info (use case, referral source, company)
 * and offers Approve (with client picker) or Reject actions via the
 * PendingSignupRow client component.
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createServerComponentClient } from '@/lib/supabase-server';
import { PendingSignupRow } from '@/components/PendingSignupRow';

export const dynamic = 'force-dynamic';

interface PendingProfile {
  id: string;
  email: string;
  full_name: string | null;
  title: string | null;
  created_at: string;
  referral_source: string | null;
  use_case: string | null;
  use_case_other: string | null;
  approval_status: string;
}

interface AuditDetails {
  company_name?: string;
  company_domain?: string;
  existing_client_id?: string | null;
  existing_client_name?: string | null;
}

interface ClientOption { id: string; name: string; domain: string | null; slug: string | null }

export default async function PendingSignupsPage() {
  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: callerProfile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null; error: any };

  if (!callerProfile || callerProfile.role !== 'admin') redirect('/');

  // Pull every pending profile, oldest first
  const { data: pending } = await (supabase
    .from('profiles' as any) as any)
    .select('id, email, full_name, title, created_at, referral_source, use_case, use_case_other, approval_status')
    .eq('approval_status', 'pending')
    .order('created_at', { ascending: true });

  const pendingList = (pending || []) as PendingProfile[];

  // Pull the most-recent 'signup_pending_approval' audit row per user
  // so we have the company info they typed (lives in audit_log.details
  // since profiles doesn't have a company_name column for unapproved
  // users).
  const { data: auditRows } = pendingList.length === 0 ? { data: [] } : await (supabase
    .from('audit_log' as any) as any)
    .select('entity_id, details, created_at')
    .in('entity_id', pendingList.map(p => p.id))
    .order('created_at', { ascending: false });

  // First (most recent) audit row per user
  const auditByUser = new Map<string, AuditDetails>();
  (auditRows || []).forEach((row: any) => {
    if (!row.entity_id) return;
    if (auditByUser.has(row.entity_id)) return;
    if (row?.details?.action === 'signup_pending_approval') {
      auditByUser.set(row.entity_id, row.details);
    }
  });

  // Pull all clients for the assignment dropdown
  const { data: clients } = await supabase
    .from('clients')
    .select('id, name, domain, slug')
    .order('name', { ascending: true }) as { data: ClientOption[] | null; error: any };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest text-gray-500 mb-1">Admin</p>
            <h1 className="text-2xl font-bold text-mt-dark">Pending Signups</h1>
            <p className="text-sm text-gray-600 mt-1">
              {pendingList.length} {pendingList.length === 1 ? 'sign-up' : 'sign-ups'} awaiting approval. Review the qualification info, assign a client, then approve.
            </p>
          </div>
          <Link href="/admin" className="text-sm text-gray-600 hover:text-gray-900 font-medium">
            ← Admin home
          </Link>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-4">
        {pendingList.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <svg className="w-12 h-12 text-emerald-400 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-mt-dark font-semibold">All caught up</p>
            <p className="text-sm text-gray-500 mt-1">No sign-ups waiting for approval. New ones land here automatically.</p>
          </div>
        ) : (
          pendingList.map(p => (
            <PendingSignupRow
              key={p.id}
              profile={p}
              audit={auditByUser.get(p.id) || {}}
              clients={clients || []}
            />
          ))
        )}
      </div>
    </div>
  );
}
