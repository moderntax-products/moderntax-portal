import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import Link from 'next/link';
import { getClassificationLabel, getClassificationColor } from '@/lib/mask';
import { AnalyticsDashboard } from '@/components/AnalyticsDashboard';

export default async function AdminAnalyticsPage() {
  const supabase = await createServerComponentClient();

  // Check authentication
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // Check if user has admin role
  const { data: adminProfile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null; error: any };

  if (!adminProfile || adminProfile.role !== 'admin') {
    redirect('/');
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* SOC 2 Data Classification Banner */}
      <div className={`border-b px-4 py-2 text-center text-xs font-semibold tracking-wide ${getClassificationColor('internal')}`}>
        🔒 {getClassificationLabel('internal')}
      </div>

      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-mt-dark">Analytics</h1>
            <p className="text-gray-600 mt-1">Portal usage, signups, and activity metrics</p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/admin"
              className="px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Admin
            </Link>
            <Link
              href="/"
              className="text-gray-600 hover:text-gray-900 font-medium text-sm"
            >
              Dashboard
            </Link>
          </div>
        </div>
      </div>

      {/* Analytics Dashboard (Client Component) */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <AnalyticsDashboard />
      </div>
    </div>
  );
}
