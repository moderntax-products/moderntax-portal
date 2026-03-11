import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import Link from 'next/link';
import { getClassificationLabel, getClassificationColor } from '@/lib/mask';
import { InviteUserForm } from '@/components/InviteUserForm';

export default async function ManagerTeamPage() {
  const supabase = await createServerComponentClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, client_id')
    .eq('id', user.id)
    .single() as { data: { role: string; client_id: string | null } | null; error: any };

  if (!profile || profile.role !== 'manager' || !profile.client_id) redirect('/');

  // Fetch client name
  const { data: client } = await supabase
    .from('clients')
    .select('id, name')
    .eq('id', profile.client_id)
    .single() as { data: { id: string; name: string } | null; error: any };

  // Fetch team members (same client)
  const { data: teamMembers } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, created_at')
    .eq('client_id', profile.client_id)
    .order('created_at', { ascending: true }) as { data: any[] | null; error: any };

  // Fetch request counts per team member
  const { data: allRequests } = await supabase
    .from('requests')
    .select('id, requested_by, status, request_entities(id)')
    .eq('client_id', profile.client_id) as { data: any[] | null; error: any };

  // Build per-member request stats
  const memberStats: Record<string, { total: number; active: number; completed: number }> = {};
  if (allRequests) {
    allRequests.forEach((req: any) => {
      const memberId = req.requested_by;
      if (!memberStats[memberId]) {
        memberStats[memberId] = { total: 0, active: 0, completed: 0 };
      }
      memberStats[memberId].total += 1;
      if (req.status === 'completed') {
        memberStats[memberId].completed += 1;
      } else if (req.status !== 'failed') {
        memberStats[memberId].active += 1;
      }
    });
  }

  const formatDate = (dateString: string) =>
    new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'manager': return 'bg-blue-100 text-blue-800';
      case 'processor': return 'bg-gray-100 text-gray-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  // Manager can only invite processors to their own client
  const clientList = client ? [{ id: client.id, name: client.name }] : [];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* SOC 2 Data Classification Banner */}
      <div className={`border-b px-4 py-2 text-center text-xs font-semibold tracking-wide ${getClassificationColor('internal')}`}>
        🔒 {getClassificationLabel('internal')}
      </div>

      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-mt-dark">My Team</h1>
            <p className="text-gray-500 text-sm mt-1">
              {client?.name} &mdash; {teamMembers?.length || 0} members
            </p>
          </div>
          <Link href="/" className="text-gray-600 hover:text-gray-900 font-medium text-sm">
            &larr; Dashboard
          </Link>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">

        {/* Invite Processor Section */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-mt-dark mb-1">Invite Loan Officer</h2>
          <p className="text-sm text-gray-500 mb-6">
            Add a new loan officer to your team. They&apos;ll receive a temporary password to log in.
          </p>
          <InviteUserForm clients={clientList} managerMode />
        </div>

        {/* Team Members */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-mt-dark">
              Team Members ({teamMembers?.length || 0})
            </h2>
          </div>

          {teamMembers && teamMembers.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Name</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Email</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Role</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Requests</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Active</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Joined</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {teamMembers.map((member: any) => {
                    const stats = memberStats[member.id] || { total: 0, active: 0, completed: 0 };
                    return (
                      <tr key={member.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4">
                          <span className="text-sm font-medium text-mt-dark">
                            {member.full_name || '—'}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-sm text-gray-600">{member.email}</span>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold capitalize ${getRoleBadgeColor(member.role)}`}>
                            {member.role}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">{stats.total}</td>
                        <td className="px-6 py-4">
                          <span className={`text-sm font-medium ${stats.active > 0 ? 'text-yellow-600' : 'text-gray-400'}`}>
                            {stats.active}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">
                          {formatDate(member.created_at)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-6 py-12 text-center">
              <p className="text-gray-500">No team members yet</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
