import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import Link from 'next/link';
import { ClearfirmBotPanel } from '@/components/ClearfirmBotPanel';

export default async function ClearfirmBotPage() {
  const supabase = await createServerComponentClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null; error: any };

  if (!profile || profile.role !== 'admin') redirect('/');

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <Link
                href="/admin"
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Admin
              </Link>
              <span className="text-gray-400">/</span>
              <span className="text-sm text-gray-700 font-medium">Clearfirm Bot</span>
            </div>
            <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
              <span className="bg-blue-100 text-blue-700 p-2 rounded-lg">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </span>
              Clearfirm 8821 Bot
            </h1>
            <p className="text-gray-500 mt-1">
              Automated 8821 processing for Clearfirm API requests with designee pre-fill
            </p>
          </div>
        </div>

        {/* Bot Panel */}
        <ClearfirmBotPanel />
      </div>
    </div>
  );
}
