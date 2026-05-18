/**
 * Admin: spin up a new ERC recovery engagement.
 * URL: /admin/erc-engagements/new
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createServerComponentClient } from '@/lib/supabase-server';
import { NewErcEngagementForm } from '@/components/NewErcEngagementForm';

export const dynamic = 'force-dynamic';

export default async function NewErcEngagementPage() {
  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (profile?.role !== 'admin') redirect('/');

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link href="/admin/erc-engagements" className="text-xs text-gray-500 hover:text-gray-700">← All engagements</Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-1 mb-2">New ERC Recovery Engagement</h1>
        <p className="text-sm text-gray-600 mb-6">
          Pick the existing entity, enter the returned-check quarters from their IRS account, optionally include the Mercury invoice link + fire the kickoff email. The merchant gets a tracking page at <code className="bg-gray-100 px-1 rounded text-xs">/erc-status/&lt;token&gt;</code> they can bookmark.
        </p>
        <NewErcEngagementForm />
      </div>
    </div>
  );
}
