import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import Link from 'next/link';
import { getClassificationLabel, getClassificationColor } from '@/lib/mask';
import { InviteUserForm } from '@/components/InviteUserForm';

export default async function TeamManagementPage() {
  const supabase = await createServerComponentClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  // Check admin role
  const { data: adminProfile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null; error: any };

  if (!adminProfile || adminProfile.role !== 'admin') redirect('/');

  // Fetch all clients
  const { data: clients } = await supabase
    .from('clients')
    .select('id, name, slug')
    .order('name', { ascending: true }) as { data: { id: string; name: string; slug: string }[] | null; error: any };

  // Fetch all users with their client info
  const { data: allProfiles } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, client_id, created_at')
    .order('created_at', { ascending: false }) as { data: any[] | null; error: any };

  // Build client lookup
  const clientLookup: Record<string, string> = {};
  if (clients) {
    clients.forEach((c) => { clientLookup[c.id] = c.name; });
  }

  // Split users into ModernTax team (admin, expert) and Customer users (manager, processor)
  const modernTaxTeam = (allProfiles || []).filter(
    (p: any) => p.role === 'admin' || p.role === 'expert'
  );
  const customerUsers = (allProfiles || []).filter(
    (p: any) => p.role !== 'admin' && p.role !== 'expert'
  );

  // Group customer users by client
  const customersByClient: Record<string, { clientName: string; members: any[] }> = {};
  customerUsers.forEach((p: any) => {
    const cid = p.client_id || 'unassigned';
    if (!customersByClient[cid]) {
      customersByClient[cid] = {
        clientName: p.client_id ? clientLookup[p.client_id] || 'Unknown Client' : 'Unassigned',
        members: [],
      };
    }
    customersByClient[cid].members.push(p);
  });

  const formatDate = (dateString: string) =>
    new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'admin': return 'bg-purple-100 text-purple-800';
      case 'expert': return 'bg-emerald-100 text-emerald-800';
      case 'manager': return 'bg-blue-100 text-blue-800';
      case 'processor': return 'bg-gray-100 text-gray-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* SOC 2 Data Classification Banner */}
      <div className={`border-b px-4 py-2 text-center text-xs font-semibold tracking-wide ${getClassificationColor('internal')}`}>
        🔒 {getClassificationLabel('internal')}
      </div>

      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/admin" className="text-gray-400 hover:text-gray-600 transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-mt-dark">Team Management</h1>
              <p className="text-gray-500 text-sm mt-1">Manage ModernTax staff and customer portal users</p>
            </div>
          </div>
          <Link href="/" className="text-gray-600 hover:text-gray-900 font-medium text-sm">
            &larr; Dashboard
          </Link>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-10">

        {/* ── ModernTax Team Section ── */}
        <section>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-slate-900 rounded-lg">
              <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-bold text-mt-dark">ModernTax Team</h2>
              <p className="text-sm text-gray-500">Admins and IRS Experts &mdash; {modernTaxTeam.length} members</p>
            </div>
          </div>

          {/* Invite Internal User */}
          <div className="bg-white rounded-lg shadow p-6 mb-4">
            <h3 className="text-sm font-semibold text-mt-dark mb-1">Invite ModernTax Staff</h3>
            <p className="text-xs text-gray-500 mb-4">
              Add an admin or IRS expert to the ModernTax team. They won&apos;t be associated with any customer.
            </p>
            <InviteUserForm internalMode defaultRole="admin" />
          </div>

          {/* Internal Team Table */}
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 bg-slate-50">
              <h3 className="text-sm font-semibold text-slate-700">
                Staff ({modernTaxTeam.length})
              </h3>
            </div>

            {modernTaxTeam.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Name</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Email</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Role</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Joined</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {modernTaxTeam.map((profile: any) => (
                      <tr key={profile.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4">
                          <span className="text-sm font-medium text-mt-dark">
                            {profile.full_name || '—'}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-sm text-gray-600">{profile.email}</span>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold capitalize ${getRoleBadgeColor(profile.role)}`}>
                            {profile.role === 'expert' ? 'IRS Expert' : profile.role}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">
                          {formatDate(profile.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-6 py-8 text-center">
                <p className="text-gray-500 text-sm">No ModernTax staff yet</p>
              </div>
            )}
          </div>
        </section>

        {/* Divider */}
        <div className="border-t border-gray-200" />

        {/* ── Customer Users Section ── */}
        <section>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-blue-100 rounded-lg">
              <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-bold text-mt-dark">Customer Users</h2>
              <p className="text-sm text-gray-500">Managers and processors from client organizations &mdash; {customerUsers.length} users</p>
            </div>
          </div>

          {/* Invite Customer User */}
          <div className="bg-white rounded-lg shadow p-6 mb-4">
            <h3 className="text-sm font-semibold text-mt-dark mb-1">Invite Customer User</h3>
            <p className="text-xs text-gray-500 mb-4">
              Add a manager or processor to a client organization (Centerstone, TMC, etc.).
            </p>
            <InviteUserForm clients={clients || []} defaultRole="processor" />
          </div>

          {/* Customer Users Grouped by Client */}
          {Object.keys(customersByClient).length > 0 ? (
            <div className="space-y-4">
              {Object.entries(customersByClient)
                .sort(([, a], [, b]) => a.clientName.localeCompare(b.clientName))
                .map(([clientId, group]) => (
                <div key={clientId} className="bg-white rounded-lg shadow overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-200 bg-blue-50 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-blue-900">
                      {group.clientName}
                    </h3>
                    <span className="text-xs text-blue-600 font-medium">
                      {group.members.length} {group.members.length === 1 ? 'user' : 'users'}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                          <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Name</th>
                          <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Email</th>
                          <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Role</th>
                          <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Joined</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {group.members.map((profile: any) => (
                          <tr key={profile.id} className="hover:bg-gray-50 transition-colors">
                            <td className="px-6 py-4">
                              <span className="text-sm font-medium text-mt-dark">
                                {profile.full_name || '—'}
                              </span>
                            </td>
                            <td className="px-6 py-4">
                              <span className="text-sm text-gray-600">{profile.email}</span>
                            </td>
                            <td className="px-6 py-4">
                              <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold capitalize ${getRoleBadgeColor(profile.role)}`}>
                                {profile.role}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-500">
                              {formatDate(profile.created_at)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow px-6 py-12 text-center">
              <p className="text-gray-500">No customer users yet</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
