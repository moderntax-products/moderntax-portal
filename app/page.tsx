import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import Link from 'next/link';
import { LogoutButton } from '@/components/LogoutButton';
import { getClassificationLabel, getClassificationColor } from '@/lib/mask';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{ search?: string; status?: string }>;
}) {
  const params: { search?: string; status?: string } = searchParams ? await searchParams : {};
  const searchQuery = (params.search ?? '').trim();
  const statusFilter = params.status ?? 'all';
  let supabase;
  try {
    supabase = await createServerComponentClient();
  } catch (err) {
    console.error('[dashboard] Failed to create Supabase client:', err);
    redirect('/login');
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select()
    .eq('id', user.id)
    .single() as { data: { id: string; email: string; full_name: string | null; role: string; client_id: string | null } | null; error: any };

  if (profileError || !profile) {
    redirect('/login');
  }

  const isManager = profile.role === 'manager';
  const isAdmin = profile.role === 'admin';
  const isProcessor = profile.role === 'processor';
  const isExpert = profile.role === 'expert';

  // Experts have their own dashboard
  if (isExpert) {
    redirect('/expert');
  }

  // Fetch requests scoped by role:
  // - Processor: only own requests
  // - Manager/Admin: all client requests
  let requests: any[] = [];
  let allClientRequests: any[] = [];
  let stats = {
    total: 0,
    pending: 0,
    completedThisWeek: 0,
    avgTurnaround: 0,
  };

  // For manager team breakdown
  let teamProfiles: { id: string; full_name: string | null; email: string }[] = [];
  let officerStats: Record<string, { name: string; total: number; completed: number; pending: number; amount: number }> = {};

  // Fetch client record for free trial status
  let clientFreeTrial = true; // default: trial active
  if (profile.client_id) {
    const { data: clientRecord } = await supabase
      .from('clients')
      .select('free_trial')
      .eq('id', profile.client_id)
      .single() as { data: { free_trial: boolean | null } | null; error: any };
    if (clientRecord?.free_trial === false) {
      clientFreeTrial = false;
    }
  }

  if (profile.client_id) {
    // Build the query — all client requests for managers, own-only for processors
    let query = supabase
      .from('requests')
      .select('*, request_entities(id, status, completed_at, created_at)')
      .eq('client_id', profile.client_id)
      .order('created_at', { ascending: false });

    if (isProcessor) {
      query = query.eq('requested_by', user.id);
    }

    const { data: fetchedRequests, error: requestsError } = await query as { data: any[] | null; error: any };

    if (!requestsError && fetchedRequests) {
      allClientRequests = fetchedRequests;
      requests = fetchedRequests;

      // Count at entity level (each EIN/SSN is a unique request unit)
      const allEntities = fetchedRequests.flatMap((r: any) => r.request_entities || []);
      stats.total = allEntities.length;
      stats.pending = allEntities.filter((e: any) => e.status !== 'completed' && e.status !== 'failed').length;

      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      // Count entities completed this week (entities have completed_at via expert flow)
      const completedEntities = allEntities.filter((e: any) => e.status === 'completed');
      stats.completedThisWeek = completedEntities.filter(
        (e: any) => e.completed_at && new Date(e.completed_at) > weekAgo
      ).length;

      if (completedEntities.length > 0) {
        // Average turnaround per entity (use entity created_at to completed_at)
        const entitiesWithTimes = completedEntities.filter((e: any) => e.completed_at && e.created_at);
        if (entitiesWithTimes.length > 0) {
          const avgMs =
            entitiesWithTimes.reduce((sum: number, e: any) => {
              return sum + (new Date(e.completed_at).getTime() - new Date(e.created_at).getTime());
            }, 0) / entitiesWithTimes.length;
          stats.avgTurnaround = Math.round(avgMs / (1000 * 60 * 60 * 24));
        }
      }
    }

    // For managers: fetch team profiles and build per-officer breakdown
    if (isManager || isAdmin) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .eq('client_id', profile.client_id) as { data: { id: string; full_name: string | null; email: string }[] | null; error: any };

      if (profiles) {
        teamProfiles = profiles;

        // Build name lookup
        const nameLookup: Record<string, string> = {};
        profiles.forEach((p) => {
          nameLookup[p.id] = p.full_name || p.email;
        });

        // Billing rates by intake method
        const RATE_PDF = 59.98;   // Per entity with signed 8821 PDF
        const RATE_CSV = 69.98;   // Per unique EIN on CSV/Excel upload
        const FREE_ENTITIES_PER_ACCOUNT = 3;

        // Flatten all entities with their request context for entity-level counting
        const allEntityRows = allClientRequests.flatMap((req: any) =>
          (req.request_entities || []).map((e: any) => ({
            ...e,
            requested_by: req.requested_by,
            intake_method: req.intake_method,
            request_created_at: req.created_at,
          }))
        );

        // Free trial gives first 3 entities free (sorted by creation time)
        let freeEntityIds = new Set<string>();
        if (clientFreeTrial) {
          const billableEntities = allEntityRows
            .filter((e: any) => e.status !== 'failed')
            .sort((a: any, b: any) => new Date(a.created_at || a.request_created_at).getTime() - new Date(b.created_at || b.request_created_at).getTime());
          freeEntityIds = new Set(billableEntities.slice(0, FREE_ENTITIES_PER_ACCOUNT).map((e: any) => e.id));
        }

        // Build per-officer stats from all entities
        allEntityRows.forEach((entity: any) => {
          const officerId = entity.requested_by;
          const officerName = nameLookup[officerId] || 'Unknown';

          if (!officerStats[officerId]) {
            officerStats[officerId] = { name: officerName, total: 0, completed: 0, pending: 0, amount: 0 };
          }
          officerStats[officerId].total += 1;

          const rate = entity.intake_method === 'csv' ? RATE_CSV : RATE_PDF;
          const isFreeEntity = freeEntityIds.has(entity.id);

          if (entity.status === 'completed') {
            officerStats[officerId].completed += 1;
            if (!isFreeEntity) {
              officerStats[officerId].amount += rate;
            }
          } else if (entity.status === 'failed') {
            // Don't count failed entities as pending
          } else {
            officerStats[officerId].pending += 1;
            // Signed/in-progress entities are also billable
            if (['8821_signed', 'irs_queue', 'processing', 'completed'].includes(entity.status)) {
              if (!isFreeEntity) {
                officerStats[officerId].amount += rate;
              }
            }
          }
        });
      }
    }
  }

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'submitted':
      case '8821_sent':
        return 'bg-blue-100 text-blue-800';
      case '8821_signed':
      case 'irs_queue':
        return 'bg-yellow-100 text-yellow-800';
      case 'processing':
        return 'bg-purple-100 text-purple-800';
      case 'completed':
        return 'bg-green-100 text-green-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const formatStatus = (status: string) => {
    switch (status) {
      case 'irs_queue': return 'IRS Queue';
      case '8821_sent': return '8821 Sent';
      case '8821_signed': return '8821 Signed';
      default:
        return status
          .split('_')
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const intakeMethodLabel = (method: string) => {
    switch (method) {
      case 'csv': return 'CSV';
      case 'pdf': return 'PDF';
      case 'manual': return 'Manual';
      default: return method;
    }
  };

  // Apply search and status filters to the requests shown in the table
  const pendingStatuses = ['submitted', '8821_sent', '8821_signed', 'irs_queue', 'processing'];

  if (searchQuery) {
    requests = requests.filter((r: any) =>
      r.loan_number?.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }

  if (statusFilter === 'pending') {
    requests = requests.filter((r: any) => pendingStatuses.includes(r.status));
  } else if (statusFilter === 'completed') {
    requests = requests.filter((r: any) => r.status === 'completed');
  } else if (statusFilter === 'failed') {
    requests = requests.filter((r: any) => r.status === 'failed');
  }

  // Check MFA enrollment status
  const { data: mfaFactors } = await supabase.auth.mfa.listFactors();
  const hasMfaEnabled = mfaFactors?.totp && mfaFactors.totp.length > 0;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* SOC 2 Data Classification Banner */}
      <div className={`border-b px-4 py-2 text-center text-xs font-semibold tracking-wide ${getClassificationColor('confidential')}`}>
        🔒 {getClassificationLabel('confidential')}
      </div>

      {/* MFA Warning Banner */}
      {!hasMfaEnabled && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-3">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-1.5 bg-red-100 rounded-full">
                <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-red-800">Multi-Factor Authentication Not Enabled</p>
                <p className="text-xs text-red-600">SOC 2 requires MFA for all users accessing sensitive data. Please enable MFA in your account settings.</p>
              </div>
            </div>
            <a
              href="/account/security"
              className="text-sm font-semibold text-red-700 hover:text-red-900 underline whitespace-nowrap"
            >
              Enable MFA →
            </a>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-mt-dark">Dashboard</h1>
            <p className="text-gray-600 mt-1">
              Welcome back, {profile.full_name || user.email}
              {isManager && (
                <span className="ml-2 inline-block px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
                  Manager
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* Admin Link (only for admins) */}
            {isAdmin && (
              <Link
                href="/admin"
                className="px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                ⚙️ Admin
              </Link>
            )}
            {/* Manager Navigation */}
            {isManager && (
              <>
                <Link
                  href="/invoicing"
                  className="px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Invoicing
                </Link>
                <Link
                  href="/team"
                  className="px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  My Team
                </Link>
              </>
            )}
            <Link
              href="/account/security"
              className="px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Settings
            </Link>
            {/* MFA Status Badge */}
            {hasMfaEnabled ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-green-100 text-green-800">
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                MFA Active
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-red-100 text-red-800">
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                MFA Off
              </span>
            )}
            <Link
              href="/new"
              className="bg-mt-green text-white px-6 py-3 rounded-lg font-semibold hover:bg-opacity-90 transition-colors"
            >
              + New Request
            </Link>
            <LogoutButton />
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-12">
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-600 text-sm font-medium">
                  {isProcessor ? 'My Entities' : 'Team Entities'}
                </p>
                <p className="text-3xl font-bold text-mt-dark mt-2">{stats.total}</p>
              </div>
              <div className="p-3 bg-mt-green bg-opacity-10 rounded-lg">
                <svg className="w-6 h-6 text-mt-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-600 text-sm font-medium">Active</p>
                <p className="text-3xl font-bold text-mt-dark mt-2">{stats.pending}</p>
              </div>
              <div className="p-3 bg-yellow-100 rounded-lg">
                <svg className="w-6 h-6 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-600 text-sm font-medium">Completed (7 days)</p>
                <p className="text-3xl font-bold text-mt-dark mt-2">{stats.completedThisWeek}</p>
              </div>
              <div className="p-3 bg-green-100 rounded-lg">
                <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-600 text-sm font-medium">
                  {isManager ? 'Team Members' : 'Avg Turnaround'}
                </p>
                <p className="text-3xl font-bold text-mt-dark mt-2">
                  {isManager
                    ? teamProfiles.length
                    : stats.avgTurnaround > 0 ? `${stats.avgTurnaround}d` : 'N/A'}
                </p>
              </div>
              <div className="p-3 bg-blue-100 rounded-lg">
                <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {isManager ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  )}
                </svg>
              </div>
            </div>
          </div>
        </div>

        {/* Manager: Team Breakdown by Loan Officer */}
        {(isManager || isAdmin) && Object.keys(officerStats).length > 0 && (
          <div className="bg-white rounded-lg shadow overflow-hidden mb-12">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-mt-dark">Breakdown by Loan Officer</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Loan Officer</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Total</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Completed</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Pending</th>
                    <th className="px-6 py-3 text-right text-sm font-semibold text-gray-700">Est. Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {Object.entries(officerStats)
                    .sort(([, a], [, b]) => b.total - a.total)
                    .map(([officerId, oStats]) => (
                      <tr key={officerId} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4">
                          <span className="text-sm font-semibold text-mt-dark">{oStats.name}</span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">{oStats.total}</td>
                        <td className="px-6 py-4">
                          <span className="text-sm font-medium text-green-600">{oStats.completed}</span>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-sm font-medium text-yellow-600">{oStats.pending}</span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <span className="text-sm font-semibold text-gray-900">
                            ${oStats.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                        </td>
                      </tr>
                    ))}
                  {/* Totals row */}
                  <tr className="bg-gray-50 font-semibold">
                    <td className="px-6 py-3 text-sm text-mt-dark">TOTAL</td>
                    <td className="px-6 py-3 text-sm text-gray-900">
                      {Object.values(officerStats).reduce((s, o) => s + o.total, 0)}
                    </td>
                    <td className="px-6 py-3 text-sm text-green-600">
                      {Object.values(officerStats).reduce((s, o) => s + o.completed, 0)}
                    </td>
                    <td className="px-6 py-3 text-sm text-yellow-600">
                      {Object.values(officerStats).reduce((s, o) => s + o.pending, 0)}
                    </td>
                    <td className="px-6 py-3 text-sm text-right text-gray-900">
                      ${Object.values(officerStats).reduce((s, o) => s + o.amount, 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Recent Requests Table */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 space-y-4">
            <h2 className="text-lg font-semibold text-mt-dark">
              {isProcessor ? 'My Requests' : 'All Requests'}
            </h2>

            {/* Search and Filter Controls */}
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
              {/* Search by loan number */}
              <form method="GET" className="flex gap-2">
                {statusFilter !== 'all' && (
                  <input type="hidden" name="status" value={statusFilter} />
                )}
                <input
                  type="text"
                  name="search"
                  placeholder="Search by loan number..."
                  defaultValue={searchQuery}
                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent w-64"
                />
                <button
                  type="submit"
                  className="px-4 py-2 bg-mt-green text-white text-sm font-medium rounded-lg hover:bg-opacity-90 transition-colors"
                >
                  Search
                </button>
                {searchQuery && (
                  <Link
                    href={statusFilter !== 'all' ? `/?status=${statusFilter}` : '/'}
                    className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    Clear
                  </Link>
                )}
              </form>

              {/* Status filter */}
              <div className="flex gap-1 flex-wrap">
                {[
                  { key: 'all', label: 'All' },
                  { key: 'pending', label: 'Pending' },
                  { key: 'completed', label: 'Completed' },
                  { key: 'failed', label: 'Failed' },
                ].map((opt) => {
                  const href = opt.key === 'all'
                    ? (searchQuery ? `/?search=${encodeURIComponent(searchQuery)}` : '/')
                    : (searchQuery ? `/?search=${encodeURIComponent(searchQuery)}&status=${opt.key}` : `/?status=${opt.key}`);
                  const isActive = statusFilter === opt.key;
                  return (
                    <Link
                      key={opt.key}
                      href={href}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                        isActive
                          ? 'bg-mt-green text-white'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {opt.label}
                    </Link>
                  );
                })}
              </div>
            </div>

            {/* Result count */}
            <p className="text-sm text-gray-500">
              Showing {requests.length} request{requests.length !== 1 ? 's' : ''}
            </p>
          </div>

          {requests.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Loan #</th>
                    {(isManager || isAdmin) && (
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Officer</th>
                    )}
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Status</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Source</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Entities</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Submitted</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {requests.map((request) => {
                    // Find officer name for manager view
                    const officerProfile = teamProfiles.find((p) => p.id === request.requested_by);
                    const officerName = officerProfile?.full_name || officerProfile?.email || '—';

                    return (
                      <tr key={request.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4">
                          <code className="text-sm font-mono text-mt-dark">{request.loan_number}</code>
                        </td>
                        {(isManager || isAdmin) && (
                          <td className="px-6 py-4 text-sm text-gray-600">{officerName}</td>
                        )}
                        <td className="px-6 py-4">
                          <span
                            className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${getStatusBadgeColor(request.status)}`}
                          >
                            {formatStatus(request.status)}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                            {intakeMethodLabel(request.intake_method)}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {request.request_entities?.length || 0}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">{formatDate(request.created_at)}</td>
                        <td className="px-6 py-4">
                          <Link
                            href={`/request/${request.id}`}
                            className="text-mt-green hover:underline font-medium text-sm"
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-6 py-12 text-center">
              <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-gray-500 font-medium mb-4">No requests yet</p>
              <p className="text-gray-400 text-sm mb-6">Get started by uploading a CSV or signed 8821 PDF.</p>
              <Link
                href="/new"
                className="inline-block bg-mt-green text-white px-6 py-3 rounded-lg font-semibold hover:bg-opacity-90 transition-colors"
              >
                Create Request
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
