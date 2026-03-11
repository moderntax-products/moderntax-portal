'use client';

import { useState, useEffect } from 'react';

interface AnalyticsData {
  period: { days: number; startDate: string };
  summary: {
    totalEvents: number;
    uniqueUsers: number;
    uniqueSessions: number;
    pageViews: number;
    logins: number;
    signups: number;
    requestsCreated: number;
    transcriptsDownloaded: number;
  };
  topPages: { path: string; views: number }[];
  recentLogins: { email: string; role: string; lastLogin: string }[];
  recentSignups: { email: string; metadata: any; date: string }[];
}

export function AnalyticsDashboard() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    async function fetchAnalytics() {
      setLoading(true);
      try {
        const res = await fetch(`/api/admin/analytics?days=${days}`);
        if (!res.ok) throw new Error('Failed to load analytics');
        const json = await res.json();
        setData(json);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchAnalytics();
  }, [days]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mt-green" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
        <p className="text-red-700">{error}</p>
        <p className="text-red-500 text-sm mt-2">Make sure the analytics migration has been run.</p>
      </div>
    );
  }

  if (!data) return null;

  const { summary, topPages, recentLogins, recentSignups } = data;

  return (
    <div className="space-y-8">
      {/* Period selector */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-500">Period:</span>
        {[7, 14, 30, 90].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${
              days === d
                ? 'bg-mt-green text-white'
                : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            {d}d
          </button>
        ))}
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Page Views" value={summary.pageViews} icon="📊" />
        <StatCard label="Unique Users" value={summary.uniqueUsers} icon="👥" />
        <StatCard label="Sessions" value={summary.uniqueSessions} icon="🔗" />
        <StatCard label="Signups" value={summary.signups} icon="🆕" color="green" />
        <StatCard label="Logins" value={summary.logins} icon="🔐" />
        <StatCard label="Requests Created" value={summary.requestsCreated} icon="📝" />
        <StatCard label="Transcripts Downloaded" value={summary.transcriptsDownloaded} icon="📥" />
        <StatCard label="Total Events" value={summary.totalEvents} icon="⚡" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Top Pages */}
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold text-mt-dark mb-4">Top Pages</h3>
          {topPages.length === 0 ? (
            <p className="text-gray-400 text-sm">No page views recorded yet</p>
          ) : (
            <div className="space-y-2">
              {topPages.map((page, i) => (
                <div key={page.path} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400 w-5">{i + 1}</span>
                    <span className="text-sm font-mono text-gray-700 truncate max-w-[300px]">
                      {page.path}
                    </span>
                  </div>
                  <span className="text-sm font-semibold text-mt-dark">{page.views}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Signups */}
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold text-mt-dark mb-4">Recent Signups</h3>
          {recentSignups.length === 0 ? (
            <p className="text-gray-400 text-sm">No signups in this period</p>
          ) : (
            <div className="space-y-3">
              {recentSignups.map((signup, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                  <div>
                    <p className="text-sm font-medium text-mt-dark">{signup.email}</p>
                    {signup.metadata?.fullName && (
                      <p className="text-xs text-gray-500">{signup.metadata.fullName}</p>
                    )}
                  </div>
                  <span className="text-xs text-gray-400">
                    {new Date(signup.date).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Active Users */}
        <div className="bg-white rounded-lg shadow p-6 lg:col-span-2">
          <h3 className="text-lg font-semibold text-mt-dark mb-4">Recent Active Users</h3>
          {recentLogins.length === 0 ? (
            <p className="text-gray-400 text-sm">No logins in this period</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-2 text-gray-500 font-medium">User</th>
                    <th className="text-left py-2 text-gray-500 font-medium">Role</th>
                    <th className="text-left py-2 text-gray-500 font-medium">Last Login</th>
                  </tr>
                </thead>
                <tbody>
                  {recentLogins.map((login, i) => (
                    <tr key={i} className="border-b border-gray-50">
                      <td className="py-2 text-mt-dark">{login.email}</td>
                      <td className="py-2">
                        <RoleBadge role={login.role} />
                      </td>
                      <td className="py-2 text-gray-500">
                        {new Date(login.lastLogin).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: number;
  icon: string;
  color?: string;
}) {
  return (
    <div className="bg-white rounded-lg shadow p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-gray-500 text-xs font-medium uppercase tracking-wide">{label}</p>
          <p
            className={`text-2xl font-bold mt-1 ${
              color === 'green' ? 'text-mt-green' : 'text-mt-dark'
            }`}
          >
            {value.toLocaleString()}
          </p>
        </div>
        <span className="text-2xl">{icon}</span>
      </div>
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  const colors: Record<string, string> = {
    admin: 'bg-purple-100 text-purple-700',
    manager: 'bg-blue-100 text-blue-700',
    processor: 'bg-gray-100 text-gray-700',
    expert: 'bg-amber-100 text-amber-700',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[role] || 'bg-gray-100 text-gray-600'}`}>
      {role}
    </span>
  );
}
