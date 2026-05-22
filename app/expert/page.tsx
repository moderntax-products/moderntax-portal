'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase';
import { ExpertAssignmentCard } from '@/components/ExpertAssignmentCard';
import { IrsCallLauncher } from '@/components/IrsCallLauncher';
import { IrsCallStatusPanel } from '@/components/IrsCallStatusPanel';
import { IrsCallHistory } from '@/components/IrsCallHistory';
import { LogoutButton } from '@/components/LogoutButton';
import { PendingBatchOffer } from '@/components/PendingBatchOffer';
import { ExpertTimeTrackerWidget } from '@/components/ExpertTimeTrackerWidget';
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
  const [profile, setProfile] = useState<{ full_name: string | null; role: string; caf_number: string | null; ptin: string | null; phone_number: string | null; address: string | null; onboarding_completed_at: string | null; onboarding_dismissed_at: string | null } | null>(null);
  const [activeTab, setActiveTab] = useState<'assignments' | 'call-history'>('assignments');
  const [selectedForCall, setSelectedForCall] = useState<{ id: string; entityName: string; entityId: string }[]>([]);
  // Multi-call orchestration: experts run multiple AI calls concurrently
  // (target throughput: ~20 calls/hour). Cap at MAX_CONCURRENT_CALLS so a
  // single human's cognitive load stays manageable. Phase 2 will add an
  // urgency indicator + auto-detect AI breakdown so the human knows
  // which call needs attention.
  const MAX_CONCURRENT_CALLS = 3;
  const [activeCallSessionIds, setActiveCallSessionIds] = useState<string[]>([]);
  // STABILIZE the supabase client across renders. Was previously called
  // inline (`const supabase = createClient()`) which created a fresh object
  // every render → fetchData useCallback's deps changed every render →
  // useEffect([fetchData]) fired every render → infinite re-fetch loop
  // that froze the dashboard. useMemo with [] deps gives us a singleton
  // for this component's lifetime.
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();

  // Check for active IRS calls on load — pulls ALL running sessions for
  // this expert (not just the first) so the dashboard restores state
  // after a refresh / browser close.
  useEffect(() => {
    async function checkActiveCalls() {
      try {
        const res = await fetch('/api/expert/irs-call/history?limit=10');
        if (res.ok) {
          const data = await res.json();
          const runningStatuses = ['initiating', 'ringing', 'navigating_ivr', 'on_hold', 'speaking_to_agent'];
          const activeSessions = (data.sessions || []).filter((s: any) =>
            runningStatuses.includes(s.status)
          );
          if (activeSessions.length > 0) {
            setActiveCallSessionIds(activeSessions.slice(0, MAX_CONCURRENT_CALLS).map((s: any) => s.id));
          }
        }
      } catch (err) {
        // Non-fatal — empty active-call list is the safe default
      }
    }
    checkActiveCalls();
  }, []);

  const handleToggleSelect = (id: string, entityName: string, entityId: string) => {
    setSelectedForCall(prev => {
      const exists = prev.find(s => s.id === id);
      if (exists) return prev.filter(s => s.id !== id);
      if (prev.length >= 5) return prev; // Max 5
      return [...prev, { id, entityName, entityId }];
    });
  };

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

      // Allow expert (their queue) AND admin (QA / support / tour
      // walkthrough) to load this page. Anyone else gets bounced.
      // Admins see the same UI but their assignments query returns
      // their own (typically empty) — that's fine for walking through
      // the tour or debugging a specific expert's setup.
      if (profileError || !profileData || !['expert', 'admin'].includes(profileData.role)) {
        router.push('/');
        return;
      }

      // Fetch credential fields separately (may not exist if migration not run).
      // Cast to any because the typegen file lags behind the migrations
      // adding onboarding_completed_at / onboarding_dismissed_at — the
      // columns DO exist in production once migration-onboarding-tracking
      // is applied; we just haven't regenerated lib/database.types.ts.
      const { data: credentialData } = await (supabase
        .from('profiles')
        .select('caf_number, ptin, phone_number, address, onboarding_completed_at, onboarding_dismissed_at')
        .eq('id', user.id)
        .single() as any) as { data: any };

      const mergedProfile = {
        ...profileData,
        caf_number: credentialData?.caf_number || null,
        ptin: credentialData?.ptin || null,
        phone_number: credentialData?.phone_number || null,
        address: credentialData?.address || null,
        onboarding_completed_at: credentialData?.onboarding_completed_at || null,
        onboarding_dismissed_at: credentialData?.onboarding_dismissed_at || null,
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

        {/* Supply-demand batch offer / active batch card */}
        <PendingBatchOffer />

        {/* Time tracker — auto-instruments SOR uploads + Bland calls;
            manual buttons for IRS direct-dial + misc sessions. */}
        <div className="mb-6">
          <ExpertTimeTrackerWidget />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Expert Queue</h1>
            <p className="text-sm text-gray-500 mt-1">
              Welcome, {profile?.full_name || 'Expert'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/expert/timesheet"
              className="px-4 py-2 text-sm bg-mt-green text-white rounded-lg hover:bg-mt-green/90 font-semibold"
              title="Clock in/out and track your hours + TINs for pay periods"
            >
              Timesheet
            </a>
            <a
              href="/expert/onboarding"
              className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              title="Take the expert onboarding tour"
            >
              Help / Tour
            </a>
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

        {/* Welcome / Take-the-tour banner — shown until expert finishes
            or dismisses the /expert/onboarding tutorial. Help link in
            the header stays visible always so they can re-take it. */}
        {profile && !profile.onboarding_completed_at && !profile.onboarding_dismissed_at && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-full bg-white">
                <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-blue-900">New here? Take the 5-minute expert tour.</p>
                <p className="text-xs text-blue-700 mt-0.5">
                  Walks you through profile setup, multi-call orchestration, IRS Direct Upload, schedule, and the SLA clock — all the workflow you need to take your first assignment.
                </p>
              </div>
            </div>
            <a
              href="/expert/onboarding"
              className="shrink-0 inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              Start tour →
            </a>
          </div>
        )}

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

        {/* Multi-call console — one panel per concurrently active call.
            Each panel carries its own transcript stream, take-over button,
            and end-call action. The expert orchestrates several at once;
            when AI breaks down (fax send, repeated tool failure, IVR
            confusion), they take over the affected call without
            disrupting the others. Capped at MAX_CONCURRENT_CALLS. */}
        {activeCallSessionIds.length > 0 && (
          <div className="mb-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-wide text-gray-700">
                Active calls ({activeCallSessionIds.length} / {MAX_CONCURRENT_CALLS})
              </h2>
              <p className="text-xs text-gray-500">Take over any call by clicking its transfer button below.</p>
            </div>
            {activeCallSessionIds.map((sessionId, idx) => (
              <div key={sessionId} className="relative">
                <div className="absolute -left-2 top-2 z-10">
                  <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-mt-dark text-white text-xs font-bold shadow">
                    {idx + 1}
                  </span>
                </div>
                <IrsCallStatusPanel
                  sessionId={sessionId}
                  onCallEnded={() => {
                    setActiveCallSessionIds(prev => prev.filter(id => id !== sessionId));
                    fetchData();
                  }}
                />
              </div>
            ))}
          </div>
        )}

        {/* Tab Navigation */}
        <div className="flex border-b border-gray-200 mb-6">
          <button
            onClick={() => setActiveTab('assignments')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'assignments'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Assignments
          </button>
          <button
            onClick={() => setActiveTab('call-history')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'call-history'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            IRS Call History
          </button>
        </div>

        {activeTab === 'call-history' ? (
          <IrsCallHistory />
        ) : (
        <>

        {/* IRS Call Launcher (multi-entity selection).
            Capacity-aware: only allows starting a new call when the expert
            has < MAX_CONCURRENT_CALLS active. New session_id appended to
            activeCallSessionIds so the panel above renders alongside any
            existing in-flight calls. */}
        <IrsCallLauncher
          selectedAssignments={selectedForCall}
          onCallStarted={(sessionId) => {
            setActiveCallSessionIds(prev => [...prev, sessionId].slice(0, MAX_CONCURRENT_CALLS));
            setSelectedForCall([]);
          }}
          onClearSelection={() => setSelectedForCall([])}
          activeCallCount={activeCallSessionIds.length}
          maxConcurrent={MAX_CONCURRENT_CALLS}
        />

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
                // Selectable as long as we're under the concurrent-call cap —
                // starting a 2nd or 3rd call should still be possible while
                // earlier calls are running.
                selectable={activeCallSessionIds.length < MAX_CONCURRENT_CALLS}
                selected={selectedForCall.some(s => s.id === assignment.id)}
                onToggleSelect={handleToggleSelect}
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

        </>
        )}
      </div>
    </div>
  );
}
