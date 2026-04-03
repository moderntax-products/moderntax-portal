'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase';
import { ExpertAssignmentCard } from '@/components/ExpertAssignmentCard';
import { LogoutButton } from '@/components/LogoutButton';
import { useRouter } from 'next/navigation';

interface AssignmentData {
  id: string;
  entity_id: string;
  status: string;
  sla_deadline: string;
  assigned_at: string;
  completed_at: string | null;
  sla_met: boolean | null;
  expert_notes: string | null;
  miss_reason: string | null;
  request_entities: {
    id: string;
    entity_name: string;
    tid: string;
    tid_kind: string;
    form_type: string;
    years: string[];
    signed_8821_url: string | null;
    transcript_urls: string[] | null;
    request_id: string;
  };
}

export default function ExpertDashboard() {
  const [assignments, setAssignments] = useState<AssignmentData[]>([]);
  const [completedAll, setCompletedAll] = useState<AssignmentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [profile, setProfile] = useState<{ full_name: string | null; role: string; caf_number: string | null; ptin: string | null; phone_number: string | null; address: string | null } | null>(null);
  const supabase = createClient();
  const router = useRouter();

  const fetchData = useCallback(async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push('/login');
        return;
      }

      // Get profile and verify expert role
      // Use select() without specific columns to avoid breaking if columns don't exist yet
      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('full_name, role')
        .eq('id', user.id)
        .single();

      if (profileError || !profileData || profileData.role !== 'expert') {
        router.push('/');
        return;
      }

      // Fetch credential fields separately (may not exist if migration not run)
      const { data: credentialData } = await supabase
        .from('profiles')
        .select('caf_number, ptin, phone_number, address')
        .eq('id', user.id)
        .single();

      const mergedProfile = {
        ...profileData,
        caf_number: credentialData?.caf_number || null,
        ptin: credentialData?.ptin || null,
        phone_number: credentialData?.phone_number || null,
        address: credentialData?.address || null,
      };

      setProfile(mergedProfile);

      // Redirect to profile setup if credentials are incomplete
      if (!mergedProfile.caf_number || !mergedProfile.ptin || !mergedProfile.phone_number || !mergedProfile.address) {
        router.push('/expert/profile');
        return;
      }

      // Fetch active assignments
      const { data: activeData, error: activeError } = await supabase
        .from('expert_assignments')
        .select('*, request_entities(id, entity_name, tid, tid_kind, form_type, years, signed_8821_url, transcript_urls, request_id)')
        .in('status', ['assigned', 'in_progress'])
        .eq('expert_id', user.id)
        .order('sla_deadline', { ascending: true });

      if (activeError) {
        console.error('Failed to fetch assignments:', activeError);
        setError('Failed to load assignments');
        return;
      }

      setAssignments((activeData as AssignmentData[]) || []);

      // Fetch all completed assignments
      const { data: completedData } = await supabase
        .from('expert_assignments')
        .select('*, request_entities(id, entity_name, tid, tid_kind, form_type, years, signed_8821_url, transcript_urls, request_id)')
        .eq('status', 'completed')
        .eq('expert_id', user.id)
        .order('completed_at', { ascending: false });

      setCompletedAll((completedData as AssignmentData[]) || []);
    } catch (err) {
      console.error('Dashboard error:', err);
      setError('Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, [supabase, router]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500">Loading expert dashboard...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-red-600">{error}</div>
      </div>
    );
  }

  // Calculate SLA stats from all completed
  const slaMetCount = completedAll.filter((a) => a.sla_met === true).length;
  const slaTotalCompleted = completedAll.filter((a) => a.sla_met !== null).length;
  const slaRate = slaTotalCompleted > 0 ? Math.round((slaMetCount / slaTotalCompleted) * 100) : 100;

  // Group completed by month for pay cycle view
  const completedByMonth: Record<string, AssignmentData[]> = {};
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  let completedTodayCount = 0;

  completedAll.forEach((a) => {
    if (a.completed_at) {
      const d = new Date(a.completed_at);
      if (d >= todayStart) completedTodayCount++;
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!completedByMonth[monthKey]) completedByMonth[monthKey] = [];
      completedByMonth[monthKey].push(a);
    }
  });

  const sortedMonths = Object.keys(completedByMonth).sort().reverse();

  const formatMonthLabel = (key: string) => {
    const [y, m] = key.split('-');
    return new Date(parseInt(y), parseInt(m) - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Classification Banner */}
        <div className="mb-4 px-3 py-1.5 bg-red-100 border border-red-300 rounded text-xs text-red-800 font-medium text-center">
          RESTRICTED — Contains PII / Tax Data
        </div>

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Expert Queue</h1>
            <p className="text-sm text-gray-500 mt-1">
              Welcome, {profile?.full_name || 'Expert'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => router.push('/expert/profile')}
              className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Edit Profile
            </button>
            <button
              onClick={fetchData}
              className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Refresh
            </button>
            <a
              href="/account/security"
              className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Settings
            </a>
            <LogoutButton />
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
            <div className="text-2xl font-bold text-blue-600">{assignments.length}</div>
            <div className="text-xs text-gray-500 uppercase tracking-wide">Active</div>
          </div>
          <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
            <div className="text-2xl font-bold text-emerald-600">{completedTodayCount}</div>
            <div className="text-xs text-gray-500 uppercase tracking-wide">Completed Today</div>
          </div>
          <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
            <div className="text-2xl font-bold text-gray-700">{completedAll.length}</div>
            <div className="text-xs text-gray-500 uppercase tracking-wide">All Time</div>
          </div>
          <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
            <div className="text-2xl font-bold text-amber-600">{slaRate}%</div>
            <div className="text-xs text-gray-500 uppercase tracking-wide">SLA Compliance</div>
          </div>
        </div>

        {/* IRS Direct Upload — Primary Workflow */}
        {assignments.length > 0 && (
          <div className="bg-gradient-to-r from-indigo-50 to-blue-50 border border-indigo-200 rounded-lg p-6 mb-8">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-indigo-900 flex items-center gap-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  IRS Direct Upload
                </h2>
                <p className="text-sm text-indigo-700 mt-1">
                  Upload transcripts directly from the IRS SOR inbox to the portal — no manual file handling needed.
                </p>
              </div>
              <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-800">
                Recommended
              </span>
            </div>

            {/* Step-by-step instructions */}
            <div className="mt-4 space-y-3">
              <div className="flex items-start gap-3 bg-white/60 rounded-lg p-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center">1</span>
                <div>
                  <p className="text-sm font-semibold text-indigo-900">Open the IRS SOR inbox</p>
                  <p className="text-xs text-indigo-600 mt-0.5">Log into the IRS Secure Object Repository and navigate to your inbox.</p>
                </div>
              </div>

              <div className="flex items-start gap-3 bg-white/60 rounded-lg p-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center">2</span>
                <div>
                  <p className="text-sm font-semibold text-indigo-900">Open the browser console</p>
                  <p className="text-xs text-indigo-600 mt-0.5">Press <kbd className="px-1.5 py-0.5 bg-indigo-100 rounded text-indigo-800 font-mono font-bold">F12</kbd> on your keyboard, then click the <strong>Console</strong> tab at the top of the panel that opens.</p>
                  <p className="text-xs text-indigo-500 mt-1 italic">If you see a paste warning, type <code className="bg-indigo-100 px-1 rounded font-mono">allow pasting</code> and press Enter first.</p>
                </div>
              </div>

              <div className="flex items-start gap-3 bg-white/60 rounded-lg p-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center">3</span>
                <div>
                  <p className="text-sm font-semibold text-indigo-900">Paste the command and press Enter</p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <code className="block bg-gray-900 text-green-400 px-3 py-2 rounded font-mono text-xs select-all flex-1">fetch(&apos;https://portal.moderntax.io/irs-batch-v6.js?v=&apos;+Date.now()).then(r=&gt;r.text()).then(eval)</code>
                    <button
                      onClick={() => { navigator.clipboard.writeText("fetch('https://portal.moderntax.io/irs-batch-v6.js?v='+Date.now()).then(r=>r.text()).then(eval)"); }}
                      className="flex-shrink-0 px-3 py-2 bg-indigo-600 text-white text-xs font-semibold rounded hover:bg-indigo-700 transition-colors"
                    >
                      Copy
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-3 bg-white/60 rounded-lg p-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center">4</span>
                <div>
                  <p className="text-sm font-semibold text-indigo-900">Log in when prompted</p>
                  <p className="text-xs text-indigo-600 mt-0.5">A popup will ask for your ModernTax email and password. Enter the same credentials you use to log into this portal.</p>
                </div>
              </div>

              <div className="flex items-start gap-3 bg-white/60 rounded-lg p-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center">5</span>
                <div>
                  <p className="text-sm font-semibold text-indigo-900">Wait for the upload to finish</p>
                  <p className="text-xs text-indigo-600 mt-0.5">A <strong>blue progress panel</strong> will appear in the top-right corner of the page. It shows each transcript being matched and uploaded in real time. When complete, you&apos;ll see a summary popup with the total uploaded.</p>
                </div>
              </div>
            </div>

            {/* How you know it worked */}
            <div className="mt-4 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
              <p className="text-xs font-semibold text-emerald-800">✅ How you know it worked:</p>
              <ul className="mt-1 text-xs text-emerald-700 space-y-0.5">
                <li>The progress panel shows uploaded transcripts with green checkmarks</li>
                <li>A final popup says &quot;Done! X transcripts uploaded to portal&quot;</li>
                <li>Your assignments below will show as <strong>Completed</strong> after you refresh this page</li>
              </ul>
            </div>

            {/* Troubleshooting */}
            <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
              <p className="text-xs font-semibold text-amber-800">⚠️ If the script doesn&apos;t work:</p>
              <ul className="mt-1 text-xs text-amber-700 space-y-0.5">
                <li><strong>Script freezes or nothing happens:</strong> Press Cancel, refresh the IRS page, and paste the command again.</li>
                <li><strong>&quot;Not yours&quot; on everything:</strong> The script matches by tax ID. Check that the TINs in your assignments match the IRS transcripts.</li>
                <li><strong>Upload failures:</strong> Failed transcripts are auto-saved to your Downloads folder. Upload them manually using the button below each assignment.</li>
                <li><strong>Login failed:</strong> Use the same email &amp; password you use to log into this portal.</li>
              </ul>
            </div>

            <p className="mt-3 text-xs text-indigo-500">
              You can also upload files manually using the &quot;Upload Transcripts&quot; button on each assignment below.
            </p>
          </div>
        )}

        {/* Active Assignments */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">
            Active Assignments ({assignments.length})
          </h2>

          {assignments.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
              <p className="text-gray-500">No active assignments. Check back soon.</p>
            </div>
          ) : (
            assignments.map((assignment) => (
              <ExpertAssignmentCard
                key={assignment.id}
                assignment={assignment}
                onRefresh={fetchData}
              />
            ))
          )}
        </div>

        {/* Completed Work — grouped by pay cycle (month) */}
        {completedAll.length > 0 && (
          <div className="mt-8 space-y-6">
            <h2 className="text-lg font-semibold text-gray-900">
              Completed Work ({completedAll.length})
            </h2>
            {sortedMonths.map((monthKey) => {
              const monthAssignments = completedByMonth[monthKey];
              const monthFileCount = monthAssignments.reduce(
                (sum, a) => sum + (a.request_entities.transcript_urls?.length || 0), 0
              );
              return (
                <div key={monthKey} className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-700">
                      {formatMonthLabel(monthKey)}
                      <span className="ml-2 text-xs font-normal text-gray-400">
                        {monthAssignments.length} {monthAssignments.length === 1 ? 'entity' : 'entities'} · {monthFileCount} files
                      </span>
                    </h3>
                  </div>
                  {monthAssignments.map((assignment) => (
                    <ExpertAssignmentCard
                      key={assignment.id}
                      assignment={assignment}
                      onRefresh={fetchData}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
