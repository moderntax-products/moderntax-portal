import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import type { RequestStatus } from '@/lib/types';
import Link from 'next/link';
import { getClassificationLabel, getClassificationColor } from '@/lib/mask';
import { FreeTrialToggle } from '@/components/FreeTrialToggle';

interface PageProps {
  searchParams: Promise<{ type?: string; search?: string; status?: string }>;
}

export default async function AdminPage({ searchParams }: PageProps) {
  const { type: productTypeFilter, search: searchFilter, status: statusFilter } = await searchParams;
  const supabase = await createServerComponentClient();

  // Check authentication
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // Check if user has admin role (role-based access)
  const { data: adminProfile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null; error: any };

  if (!adminProfile || adminProfile.role !== 'admin') {
    redirect('/');
  }

  // Fetch all clients
  const { data: clients, error: clientsError } = await supabase
    .from('clients')
    .select('*')
    .order('name', { ascending: true }) as { data: { id: string; name: string; slug: string; domain: string | null; free_trial: boolean | null; api_key: string | null; api_request_limit: number | null; billing_payment_method: string | null; billing_ap_email: string | null; billing_ap_phone: string | null; billing_rate_pdf: number; billing_rate_csv: number }[] | null; error: any };

  // Fetch all requests with entities (include completed_at for revenue calc) and client info
  const { data: allRequests, error: requestsError } = await supabase
    .from('requests')
    .select('*, request_entities(id, entity_name, status, completed_at), clients(name, slug)')
    .order('created_at', { ascending: false }) as { data: any[] | null; error: any };

  // Fetch invoices for billing overview
  const { data: allInvoices } = await supabase
    .from('invoices')
    .select('*, clients(name, slug)')
    .order('billing_period_start', { ascending: false })
    .limit(10) as { data: any[] | null; error: any };

  // Query stuck entities — entities in non-terminal statuses for too long
  const now = new Date();
  const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

  const { data: stuckSentEntities } = await supabase
    .from('request_entities')
    .select('id, entity_name, status, updated_at, request_id, requests(loan_number, clients(name))')
    .eq('status', '8821_sent')
    .lt('updated_at', fiveDaysAgo) as { data: any[] | null; error: any };

  const { data: stuckQueueEntities } = await supabase
    .from('request_entities')
    .select('id, entity_name, status, updated_at, request_id, requests(loan_number, clients(name))')
    .eq('status', 'irs_queue')
    .lt('updated_at', fortyEightHoursAgo) as { data: any[] | null; error: any };

  const { data: stuckProcessingEntities } = await supabase
    .from('request_entities')
    .select('id, entity_name, status, updated_at, request_id, requests(loan_number, clients(name))')
    .eq('status', 'processing')
    .lt('updated_at', fortyEightHoursAgo) as { data: any[] | null; error: any };

  const stuckEntities = [
    ...(stuckSentEntities || []),
    ...(stuckQueueEntities || []),
    ...(stuckProcessingEntities || []),
  ];

  // Fetch entities with compliance flags (gross_receipts JSONB contains severity/flags)
  const { data: allCompletedEntities } = await supabase
    .from('request_entities')
    .select('id, entity_name, status, gross_receipts, request_id, updated_at, requests(loan_number, clients(name))')
    .eq('status', 'completed')
    .not('gross_receipts', 'is', null) as { data: any[] | null; error: any };

  const complianceFlaggedEntities = (allCompletedEntities || []).filter((e: any) => {
    if (!e.gross_receipts || typeof e.gross_receipts !== 'object') return false;
    return Object.values(e.gross_receipts).some(
      (val: any) => val && typeof val === 'object' && val.severity && ['CRITICAL', 'WARNING'].includes(val.severity)
    );
  }).map((e: any) => {
    const entries = Object.values(e.gross_receipts) as any[];
    const hasCritical = entries.some((v: any) => v?.severity === 'CRITICAL');
    const flagCount = entries.reduce((sum: number, v: any) => sum + (v?.flags?.length || 0), 0);
    return { ...e, hasCritical, flagCount };
  }).sort((a: any, b: any) => (a.hasCritical === b.hasCritical ? b.flagCount - a.flagCount : a.hasCritical ? -1 : 1));

  const getStuckDuration = (updatedAt: string) => {
    const diff = now.getTime() - new Date(updatedAt).getTime();
    const days = Math.floor(diff / (24 * 60 * 60 * 1000));
    const hours = Math.floor((diff % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    if (days > 0) return `${days}d ${hours}h`;
    return `${hours}h`;
  };

  // Calculate stats per client — count at entity (EIN/SSN) level, not request level
  const clientStats: Record<
    string,
    {
      name: string;
      total: number;
      pending: number;
      completed: number;
      failed: number;
      api_key: string | null;
      api_request_limit: number | null;
      employment_count: number;
    }
  > = {};

  if (!clientsError && clients) {
    clients.forEach((client) => {
      clientStats[client.id] = {
        name: client.name,
        total: 0,
        pending: 0,
        completed: 0,
        failed: 0,
        api_key: client.api_key,
        api_request_limit: client.api_request_limit,
        employment_count: 0,
      };
    });
  }

  if (!requestsError && allRequests) {
    allRequests.forEach((request: any) => {
      if (clientStats[request.client_id]) {
        const entities = request.request_entities || [];
        // Count each entity (EIN/SSN) individually
        entities.forEach((entity: any) => {
          clientStats[request.client_id].total += 1;
          if (entity.status === 'completed') {
            clientStats[request.client_id].completed += 1;
          } else if (entity.status === 'failed') {
            clientStats[request.client_id].failed += 1;
          } else {
            clientStats[request.client_id].pending += 1;
          }
        });

        if (request.product_type === 'employment') {
          clientStats[request.client_id].employment_count += 1;
        }
      }
    });
  }

  // Filter requests by product type, search, and status
  let filteredRequests = allRequests || [];
  if (productTypeFilter && productTypeFilter !== 'all') {
    filteredRequests = filteredRequests.filter((r: any) => r.product_type === productTypeFilter);
  }
  if (searchFilter) {
    const searchLower = searchFilter.toLowerCase();
    filteredRequests = filteredRequests.filter((r: any) => {
      // Search by loan number
      if (r.loan_number?.toLowerCase().includes(searchLower)) return true;
      // Search by client name
      if (r.clients?.name?.toLowerCase().includes(searchLower)) return true;
      // Search by entity name (borrower / taxpayer name)
      const entities = r.request_entities || [];
      if (entities.some((e: any) => e.entity_name?.toLowerCase().includes(searchLower))) return true;
      return false;
    });
  }
  if (statusFilter && statusFilter !== 'all') {
    filteredRequests = filteredRequests.filter((r: any) => r.status === statusFilter);
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
    const statusLabels: Record<string, string> = {
      'irs_queue': 'IRS Queue',
      '8821_sent': '8821 Sent',
      '8821_signed': '8821 Signed',
    };
    if (statusLabels[status]) return statusLabels[status];
    return status
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  // Count total stats at entity level
  const allEntities = allRequests?.flatMap((r: any) => r.request_entities || []) || [];
  const totalStats = {
    total: allEntities.length,
    completed: allEntities.filter((e: any) => e.status === 'completed').length,
    pending: allEntities.filter((e: any) => e.status !== 'completed' && e.status !== 'failed').length,
    failed: allEntities.filter((e: any) => e.status === 'failed').length,
  };

  // --- Billing & Revenue Calculations ---
  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

  // Current month (April) + Previous month (March)
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  const prevMonthLabel = prevMonthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const currentMonthLabel = currentMonthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Per-client revenue: current month + previous month + all-time
  const clientRevenueCurrent: Record<string, number> = {};
  const clientRevenueEntitiesCurrent: Record<string, number> = {};
  const clientRevenuePrev: Record<string, number> = {};
  const clientRevenueEntitiesPrev: Record<string, number> = {};
  const clientRevenueAllTime: Record<string, number> = {};
  const clientRevenueEntitiesAllTime: Record<string, number> = {};
  (clients || []).forEach((c) => {
    clientRevenueCurrent[c.id] = 0; clientRevenueEntitiesCurrent[c.id] = 0;
    clientRevenuePrev[c.id] = 0; clientRevenueEntitiesPrev[c.id] = 0;
    clientRevenueAllTime[c.id] = 0; clientRevenueEntitiesAllTime[c.id] = 0;
  });

  // Build free trial sets (first 3 completed entities per client)
  const freeTrialSets: Record<string, Set<string>> = {};
  (clients || []).forEach((c) => {
    if (c.free_trial) {
      const sorted = (allRequests || [])
        .filter((r: any) => r.client_id === c.id)
        .flatMap((r: any) => (r.request_entities || []).filter((e: any) => e.status === 'completed' && e.completed_at))
        .sort((a: any, b: any) => new Date(a.completed_at).getTime() - new Date(b.completed_at).getTime());
      freeTrialSets[c.id] = new Set(sorted.slice(0, 3).map((e: any) => e.id));
    } else {
      freeTrialSets[c.id] = new Set();
    }
  });

  (allRequests || []).forEach((req: any) => {
    const clientId = req.client_id;
    if (!clientRevenueCurrent.hasOwnProperty(clientId)) return;
    const clientObj = (clients || []).find((c) => c.id === clientId);
    if (!clientObj) return;

    (req.request_entities || []).forEach((entity: any) => {
      if (entity.status !== 'completed' || !entity.completed_at) return;
      if (freeTrialSets[clientId]?.has(entity.id)) return;

      const completedDate = new Date(entity.completed_at);
      const rate = req.intake_method === 'csv' ? (clientObj.billing_rate_csv || 69.98) : (clientObj.billing_rate_pdf || 59.98);

      // All-time
      clientRevenueAllTime[clientId] += rate;
      clientRevenueEntitiesAllTime[clientId] += 1;

      // Current month
      if (completedDate >= currentMonthStart && completedDate <= currentMonthEnd) {
        clientRevenueCurrent[clientId] += rate;
        clientRevenueEntitiesCurrent[clientId] += 1;
      }

      // Previous month
      if (completedDate >= prevMonthStart && completedDate <= prevMonthEnd) {
        clientRevenuePrev[clientId] += rate;
        clientRevenueEntitiesPrev[clientId] += 1;
      }
    });
  });

  const totalRevenueCurrent = Object.values(clientRevenueCurrent).reduce((sum, v) => sum + v, 0);
  const totalBillableEntitiesCurrent = Object.values(clientRevenueEntitiesCurrent).reduce((sum, v) => sum + v, 0);
  const totalRevenuePrev = Object.values(clientRevenuePrev).reduce((sum, v) => sum + v, 0);
  const totalBillableEntitiesPrev = Object.values(clientRevenueEntitiesPrev).reduce((sum, v) => sum + v, 0);
  const totalRevenueAllTime = Object.values(clientRevenueAllTime).reduce((sum, v) => sum + v, 0);
  const totalBillableEntitiesAllTime = Object.values(clientRevenueEntitiesAllTime).reduce((sum, v) => sum + v, 0);

  // Invoice stats
  const outstandingAR = (allInvoices || [])
    .filter((i: any) => i.status === 'sent' || i.status === 'overdue')
    .reduce((sum: number, i: any) => sum + (i.total_amount || 0), 0);
  const overdueAR = (allInvoices || [])
    .filter((i: any) => i.status === 'overdue')
    .reduce((sum: number, i: any) => sum + (i.total_amount || 0), 0);
  const overdueInvoices = (allInvoices || []).filter((i: any) => i.status === 'overdue').length;

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
            <h1 className="text-3xl font-bold text-mt-dark">Admin Dashboard</h1>
            <p className="text-gray-600 mt-1">Cross-client overview and management</p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/admin/billing"
              className="px-4 py-2 text-sm font-medium text-white bg-mt-green rounded-lg hover:bg-mt-green/90 transition-colors"
            >
              Billing
            </Link>
            <Link
              href="/admin/email-intake"
              className="px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Email Intake
            </Link>
            <Link
              href="/admin/analytics"
              className="px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Analytics
            </Link>
            <Link
              href="/admin/experts"
              className="px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              IRS Experts
            </Link>
            <Link
              href="/admin/clearfirm-bot"
              className="px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors"
            >
              Clearfirm Bot
            </Link>
            <Link
              href="/admin/team"
              className="px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Team
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

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* System-wide Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-12">
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-600 text-sm font-medium">Total Entities</p>
                <p className="text-3xl font-bold text-mt-dark mt-2">{totalStats.total}</p>
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
                <p className="text-gray-600 text-sm font-medium">Completed</p>
                <p className="text-3xl font-bold text-green-600 mt-2">{totalStats.completed}</p>
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
                <p className="text-gray-600 text-sm font-medium">Pending</p>
                <p className="text-3xl font-bold text-yellow-600 mt-2">{totalStats.pending}</p>
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
                <p className="text-gray-600 text-sm font-medium">Failed</p>
                <p className="text-3xl font-bold text-red-600 mt-2">{totalStats.failed}</p>
              </div>
              <div className="p-3 bg-red-100 rounded-lg">
                <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4v2m0 0v2m0-2h2m-2 0h-2" />
                </svg>
              </div>
            </div>
          </div>
        </div>

        {/* Billing & Revenue Stats */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-6 mb-12">
          <div className="bg-white rounded-lg shadow p-6 border-l-4 border-mt-green">
            <p className="text-gray-600 text-sm font-medium">{prevMonthLabel} Revenue</p>
            <p className="text-3xl font-bold text-mt-dark mt-2">{formatCurrency(totalRevenuePrev)}</p>
            <p className="text-xs text-gray-400 mt-1">{totalBillableEntitiesPrev} billable entities</p>
          </div>
          <div className="bg-white rounded-lg shadow p-6 border-l-4 border-emerald-300">
            <p className="text-gray-600 text-sm font-medium">{currentMonthLabel} Revenue</p>
            <p className="text-3xl font-bold text-mt-dark mt-2">{formatCurrency(totalRevenueCurrent)}</p>
            <p className="text-xs text-gray-400 mt-1">{totalBillableEntitiesCurrent} billable entities</p>
          </div>
          <div className="bg-white rounded-lg shadow p-6 border-l-4 border-yellow-400">
            <p className="text-gray-600 text-sm font-medium">Outstanding AR</p>
            <p className="text-3xl font-bold text-yellow-600 mt-2">{formatCurrency(outstandingAR)}</p>
            <p className="text-xs text-gray-400 mt-1">Sent &amp; awaiting payment</p>
          </div>
          <div className="bg-white rounded-lg shadow p-6 border-l-4 border-red-400">
            <p className="text-gray-600 text-sm font-medium">Overdue</p>
            <p className={`text-3xl font-bold mt-2 ${overdueAR > 0 ? 'text-red-600' : 'text-green-600'}`}>{formatCurrency(overdueAR)}</p>
            <p className="text-xs text-gray-400 mt-1">{overdueInvoices} overdue invoice{overdueInvoices !== 1 ? 's' : ''}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-6 border-l-4 border-blue-400">
            <p className="text-gray-600 text-sm font-medium">All-Time Revenue</p>
            <p className="text-3xl font-bold text-mt-dark mt-2">{formatCurrency(totalRevenueAllTime)}</p>
            <p className="text-xs text-gray-400 mt-1">{totalBillableEntitiesAllTime} entities total</p>
          </div>
        </div>

        {/* Stuck Entities Warning */}
        {stuckEntities.length > 0 && (
          <div className="mb-12 bg-amber-50 border border-amber-300 rounded-lg p-6">
            <div className="flex items-center gap-2 mb-4">
              <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <h3 className="text-lg font-bold text-amber-800">Stuck Entities ({stuckEntities.length})</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-amber-200">
                    <th className="px-4 py-2 text-left font-semibold text-amber-900">Entity</th>
                    <th className="px-4 py-2 text-left font-semibold text-amber-900">Client</th>
                    <th className="px-4 py-2 text-left font-semibold text-amber-900">Status</th>
                    <th className="px-4 py-2 text-left font-semibold text-amber-900">Stuck For</th>
                    <th className="px-4 py-2 text-left font-semibold text-amber-900">Request</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-amber-100">
                  {stuckEntities.map((entity: any) => (
                    <tr key={entity.id}>
                      <td className="px-4 py-2 font-medium text-amber-900">{entity.entity_name}</td>
                      <td className="px-4 py-2 text-amber-800">{entity.requests?.clients?.name || '—'}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${getStatusBadgeColor(entity.status)}`}>
                          {formatStatus(entity.status)}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-amber-800 font-mono">{getStuckDuration(entity.updated_at)}</td>
                      <td className="px-4 py-2">
                        <Link
                          href={`/admin/requests/${entity.request_id}`}
                          className="text-amber-700 hover:text-amber-900 underline font-medium"
                        >
                          {entity.requests?.loan_number || 'View'}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Compliance Alerts */}
        {complianceFlaggedEntities.length > 0 && (
          <div className="mb-12 bg-red-50 border border-red-300 rounded-lg p-6">
            <div className="flex items-center gap-2 mb-4">
              <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <h3 className="text-lg font-bold text-red-800">
                Compliance Alerts ({complianceFlaggedEntities.length} entit{complianceFlaggedEntities.length === 1 ? 'y' : 'ies'})
              </h3>
              <span className="ml-2 px-2 py-0.5 bg-red-200 text-red-900 text-xs font-bold rounded-full">
                {complianceFlaggedEntities.filter((e: any) => e.hasCritical).length} Critical
              </span>
            </div>
            <p className="text-sm text-red-700 mb-4">
              These entities have IRS compliance flags detected during transcript processing. Upsell emails were auto-sent to signers.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-red-200">
                    <th className="px-4 py-2 text-left font-semibold text-red-900">Entity</th>
                    <th className="px-4 py-2 text-left font-semibold text-red-900">Client</th>
                    <th className="px-4 py-2 text-left font-semibold text-red-900">Severity</th>
                    <th className="px-4 py-2 text-left font-semibold text-red-900">Flags</th>
                    <th className="px-4 py-2 text-left font-semibold text-red-900">Request</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-red-100">
                  {complianceFlaggedEntities.slice(0, 20).map((entity: any) => (
                    <tr key={entity.id}>
                      <td className="px-4 py-2 font-medium text-red-900">{entity.entity_name}</td>
                      <td className="px-4 py-2 text-red-800">{entity.requests?.clients?.name || '—'}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold ${
                          entity.hasCritical ? 'bg-red-200 text-red-900' : 'bg-amber-200 text-amber-900'
                        }`}>
                          {entity.hasCritical ? 'CRITICAL' : 'WARNING'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-red-800 font-mono">{entity.flagCount}</td>
                      <td className="px-4 py-2">
                        <Link
                          href={`/admin/requests/${entity.request_id}`}
                          className="text-red-700 hover:text-red-900 underline font-medium"
                        >
                          {entity.requests?.loan_number || 'View'}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {complianceFlaggedEntities.length > 20 && (
                <p className="text-xs text-red-600 mt-2 px-4">
                  Showing 20 of {complianceFlaggedEntities.length} flagged entities
                </p>
              )}
            </div>
          </div>
        )}

        {/* Client Stats */}
        <div className="mb-12">
          <h2 className="text-2xl font-bold text-mt-dark mb-6">Client Overview</h2>
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Client</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Free Trial</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Total</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Completed</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Pending</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Failed</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">API Usage</th>
                    <th className="px-6 py-3 text-right text-sm font-semibold text-gray-700">Revenue ({prevMonthLabel})</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Payment</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Completion Rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {Object.entries(clientStats).map(([clientId, stats]) => {
                    const completionRate =
                      stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;
                    const clientObj = clients?.find((c) => c.id === clientId);
                    return (
                      <tr key={clientId} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4 font-semibold text-mt-dark">{stats.name}</td>
                        <td className="px-6 py-4">
                          <FreeTrialToggle
                            clientId={clientId}
                            clientName={stats.name}
                            initialValue={clientObj?.free_trial ?? true}
                          />
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">{stats.total}</td>
                        <td className="px-6 py-4">
                          <span className="text-sm font-medium text-green-600">{stats.completed}</span>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-sm font-medium text-yellow-600">{stats.pending}</span>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-sm font-medium text-red-600">{stats.failed}</span>
                        </td>
                        <td className="px-6 py-4">
                          {stats.api_key ? (
                            <span className="text-sm text-gray-700">
                              {stats.employment_count}
                              {stats.api_request_limit && (
                                <span className="text-gray-400"> / {stats.api_request_limit}</span>
                              )}
                            </span>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right">
                          {(clientRevenuePrev[clientId] || 0) > 0 ? (
                            <div>
                              <span className="text-sm font-bold text-mt-dark">{formatCurrency(clientRevenuePrev[clientId] || 0)}</span>
                              <p className="text-xs text-gray-400">{clientRevenueEntitiesPrev[clientId] || 0} entities</p>
                            </div>
                          ) : (
                            <span className="text-xs text-gray-400">$0.00</span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          {clientObj?.billing_payment_method ? (
                            <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-green-100 text-green-700">
                              {clientObj.billing_payment_method.toUpperCase()}
                            </span>
                          ) : (
                            <span className="text-xs text-gray-400">Not set</span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <div className="w-24 bg-gray-200 rounded-full h-2">
                              <div
                                className="bg-mt-green h-2 rounded-full"
                                style={{ width: `${completionRate}%` }}
                              ></div>
                            </div>
                            <span className="text-sm font-medium text-gray-700">{completionRate}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Recent Invoices */}
        {(allInvoices || []).length > 0 && (
          <div className="mb-12">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-2xl font-bold text-mt-dark">Recent Invoices</h2>
              <Link
                href="/admin/billing"
                className="text-sm font-medium text-mt-green hover:underline"
              >
                View Full Billing Dashboard →
              </Link>
            </div>
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Invoice #</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Client</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Period</th>
                      <th className="px-6 py-3 text-right text-sm font-semibold text-gray-700">Entities</th>
                      <th className="px-6 py-3 text-right text-sm font-semibold text-gray-700">Amount</th>
                      <th className="px-6 py-3 text-center text-sm font-semibold text-gray-700">Status</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Due Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {(allInvoices || []).map((inv: any) => (
                      <tr key={inv.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-3">
                          <code className="text-sm font-mono text-mt-dark">{inv.invoice_number}</code>
                        </td>
                        <td className="px-6 py-3 text-sm text-gray-700">{inv.clients?.name || '—'}</td>
                        <td className="px-6 py-3 text-sm text-gray-600">
                          {new Date(inv.billing_period_start).toLocaleDateString('en-US', { year: 'numeric', month: 'short' })}
                        </td>
                        <td className="px-6 py-3 text-right text-sm text-gray-700">{inv.total_entities}</td>
                        <td className="px-6 py-3 text-right text-sm font-bold text-mt-dark">{formatCurrency(inv.total_amount)}</td>
                        <td className="px-6 py-3 text-center">
                          <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${
                            inv.status === 'paid' ? 'bg-green-100 text-green-700' :
                            inv.status === 'overdue' ? 'bg-red-100 text-red-700' :
                            inv.status === 'sent' ? 'bg-blue-100 text-blue-700' :
                            'bg-gray-100 text-gray-700'
                          }`}>
                            {inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}
                          </span>
                        </td>
                        <td className="px-6 py-3 text-sm text-gray-600">
                          {inv.due_date ? formatDate(inv.due_date) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* All Requests */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-bold text-mt-dark">All Requests</h2>
            <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
              {(() => {
                const baseParams = new URLSearchParams();
                if (searchFilter) baseParams.set('search', searchFilter);
                if (statusFilter && statusFilter !== 'all') baseParams.set('status', statusFilter);
                const allHref = baseParams.toString() ? `/admin?${baseParams.toString()}` : '/admin';

                const transcriptParams = new URLSearchParams(baseParams);
                transcriptParams.set('type', 'transcript');

                const employmentParams = new URLSearchParams(baseParams);
                employmentParams.set('type', 'employment');

                return (
                  <>
                    <Link
                      href={allHref}
                      className={`px-4 py-2 font-medium transition-colors ${
                        !productTypeFilter || productTypeFilter === 'all'
                          ? 'bg-mt-dark text-white'
                          : 'bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      All
                    </Link>
                    <Link
                      href={`/admin?${transcriptParams.toString()}`}
                      className={`px-4 py-2 font-medium border-l border-gray-300 transition-colors ${
                        productTypeFilter === 'transcript'
                          ? 'bg-mt-dark text-white'
                          : 'bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      Transcripts
                    </Link>
                    <Link
                      href={`/admin?${employmentParams.toString()}`}
                      className={`px-4 py-2 font-medium border-l border-gray-300 transition-colors ${
                        productTypeFilter === 'employment'
                          ? 'bg-mt-dark text-white'
                          : 'bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      Employment
                    </Link>
                  </>
                );
              })()}
            </div>
          </div>

          {/* Search and Status Filter */}
          <div className="flex items-center gap-4 mb-6">
            <form className="flex items-center gap-4 flex-1">
              {productTypeFilter && productTypeFilter !== 'all' && (
                <input type="hidden" name="type" value={productTypeFilter} />
              )}
              {statusFilter && statusFilter !== 'all' && (
                <input type="hidden" name="status" value={statusFilter} />
              )}
              <div className="relative flex-1 max-w-sm">
                <input
                  type="text"
                  name="search"
                  defaultValue={searchFilter || ''}
                  placeholder="Search by entity name, loan number, or client..."
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent"
                />
                <svg className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <button type="submit" className="px-4 py-2 text-sm font-medium text-white bg-mt-green rounded-lg hover:bg-mt-green/90 transition-colors">
                Search
              </button>
            </form>
            <form>
              {productTypeFilter && productTypeFilter !== 'all' && (
                <input type="hidden" name="type" value={productTypeFilter} />
              )}
              {searchFilter && (
                <input type="hidden" name="search" value={searchFilter} />
              )}
              <select
                name="status"
                defaultValue={statusFilter || 'all'}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent"
                // Use form submission via noscript-friendly approach
                // The onchange below won't work in a Server Component, so users submit the form
              >
                <option value="all">All Statuses</option>
                <option value="submitted">Submitted</option>
                <option value="8821_sent">8821 Sent</option>
                <option value="8821_signed">8821 Signed</option>
                <option value="irs_queue">IRS Queue</option>
                <option value="processing">Processing</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
              </select>
              <button type="submit" className="ml-2 px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
                Filter
              </button>
            </form>
            {(searchFilter || (statusFilter && statusFilter !== 'all')) && (
              <Link
                href={productTypeFilter && productTypeFilter !== 'all' ? `/admin?type=${productTypeFilter}` : '/admin'}
                className="text-sm text-gray-500 hover:text-gray-700 underline"
              >
                Clear filters
              </Link>
            )}
          </div>

          {/* Result count */}
          <p className="text-sm text-gray-500 mb-4">
            Showing {filteredRequests.length} request{filteredRequests.length !== 1 ? 's' : ''}
            {searchFilter && <span> matching &ldquo;{searchFilter}&rdquo;</span>}
            {statusFilter && statusFilter !== 'all' && <span> with status {formatStatus(statusFilter)}</span>}
          </p>
          <div className="bg-white rounded-lg shadow overflow-hidden">
            {filteredRequests.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Client</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Type</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Account</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Status</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Entity Names</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Progress</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Submitted</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {filteredRequests.map((request: any) => (
                      <tr key={request.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4">
                          <span className="text-sm font-medium text-gray-700">
                            {request.clients?.name || 'Unknown'}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${
                            request.product_type === 'employment'
                              ? 'bg-indigo-100 text-indigo-700'
                              : 'bg-blue-100 text-blue-700'
                          }`}>
                            {request.product_type === 'employment' ? 'Employment' : 'Transcript'}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <code className="text-sm font-mono text-mt-dark">{request.loan_number}</code>
                        </td>
                        <td className="px-6 py-4">
                          {(() => {
                            const entities = request.request_entities || [];
                            const completedCount = entities.filter((e: any) => e.status === 'completed').length;
                            const allComplete = entities.length > 0 && completedCount === entities.length;
                            const anyFailed = entities.some((e: any) => e.status === 'failed');
                            const displayStatus = allComplete ? 'completed' : anyFailed ? 'failed' : request.status;
                            return (
                              <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${getStatusBadgeColor(displayStatus as RequestStatus)}`}>
                                {formatStatus(displayStatus)}
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-6 py-4">
                          {(() => {
                            const entities = request.request_entities || [];
                            if (entities.length === 0) return <span className="text-xs text-gray-400">None</span>;
                            const searchLower = searchFilter?.toLowerCase();
                            return (
                              <div className="flex flex-wrap gap-1 max-w-xs">
                                {entities.map((e: any) => {
                                  const isMatch = searchLower && e.entity_name?.toLowerCase().includes(searchLower);
                                  return (
                                    <span
                                      key={e.id}
                                      className={`inline-block px-2 py-0.5 rounded text-xs ${
                                        isMatch
                                          ? 'bg-yellow-100 text-yellow-800 font-semibold ring-1 ring-yellow-300'
                                          : e.status === 'completed'
                                          ? 'bg-green-50 text-green-700'
                                          : e.status === 'failed'
                                          ? 'bg-red-50 text-red-700'
                                          : 'bg-gray-100 text-gray-700'
                                      }`}
                                    >
                                      {e.entity_name}
                                    </span>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {(() => {
                            const entities = request.request_entities || [];
                            const completedCount = entities.filter((e: any) => e.status === 'completed').length;
                            return (
                              <span>
                                <span className="font-medium text-green-600">{completedCount}</span>
                                <span className="text-gray-400"> / </span>
                                <span>{entities.length}</span>
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {formatDate(request.created_at)}
                        </td>
                        <td className="px-6 py-4 flex gap-2">
                          <Link
                            href={`/admin/requests/${request.id}`}
                            className="text-mt-green hover:underline font-medium text-sm"
                          >
                            Manage
                          </Link>
                          <Link
                            href={`/request/${request.id}`}
                            className="text-gray-400 hover:text-gray-600 text-sm"
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-6 py-12 text-center">
                <p className="text-gray-500 font-medium">No requests yet</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
