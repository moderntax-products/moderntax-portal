import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import type { RequestStatus } from '@/lib/types';
import Link from 'next/link';
import { getClassificationLabel, getClassificationColor } from '@/lib/mask';
import { FreeTrialToggle } from '@/components/FreeTrialToggle';

export default async function AdminPage() {
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
    .order('name', { ascending: true }) as { data: { id: string; name: string; slug: string; domain: string | null; free_trial: boolean | null }[] | null; error: any };

  // Fetch all requests with entities and client info
  const { data: allRequests, error: requestsError } = await supabase
    .from('requests')
    .select('*, request_entities(id, status), clients(name, slug)')
    .order('created_at', { ascending: false }) as { data: any[] | null; error: any };

  // Calculate stats per client
  const clientStats: Record<
    string,
    {
      name: string;
      total: number;
      pending: number;
      completed: number;
      failed: number;
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
      };
    });
  }

  if (!requestsError && allRequests) {
    allRequests.forEach((request: any) => {
      if (clientStats[request.client_id]) {
        clientStats[request.client_id].total += 1;

        if (request.status === 'completed') {
          clientStats[request.client_id].completed += 1;
        } else if (request.status === 'failed') {
          clientStats[request.client_id].failed += 1;
        } else {
          clientStats[request.client_id].pending += 1;
        }
      }
    });
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

  const totalStats = {
    total: allRequests?.length || 0,
    completed: allRequests?.filter((r: any) => r.status === 'completed').length || 0,
    pending: allRequests?.filter((r: any) => r.status !== 'completed' && r.status !== 'failed').length || 0,
    failed: allRequests?.filter((r: any) => r.status === 'failed').length || 0,
  };

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
                <p className="text-gray-600 text-sm font-medium">Total Requests</p>
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

        {/* All Requests */}
        <div>
          <h2 className="text-2xl font-bold text-mt-dark mb-6">All Requests</h2>
          <div className="bg-white rounded-lg shadow overflow-hidden">
            {allRequests && allRequests.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Client</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Account</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Status</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Entities</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Submitted</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {allRequests.map((request: any) => (
                      <tr key={request.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4">
                          <span className="text-sm font-medium text-gray-700">
                            {request.clients?.name || 'Unknown'}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <code className="text-sm font-mono text-mt-dark">{request.loan_number}</code>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${getStatusBadgeColor(request.status as RequestStatus)}`}>
                            {formatStatus(request.status)}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {request.request_entities?.length || 0}
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
