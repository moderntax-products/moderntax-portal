'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import type { ExpertPerformanceStats } from '@/lib/types';
import { getClassificationLabel, getClassificationColor } from '@/lib/mask';
import Link from 'next/link';
import { InviteUserForm } from '@/components/InviteUserForm';

export default function AdminExpertsPage() {
  const [stats, setStats] = useState<ExpertPerformanceStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const checkAuthAndFetch = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.push('/login'); return; }

      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single() as { data: { role: string } | null; error: any };

      if (!profile || profile.role !== 'admin') { router.push('/'); return; }

      const res = await fetch('/api/admin/expert/performance');
      if (res.ok) {
        const data = await res.json();
        setStats(data.stats || []);
      }
      setLoading(false);
    };

    checkAuthAndFetch();
  }, [supabase, router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500" />
      </div>
    );
  }

  const totals = stats.reduce(
    (acc, s) => ({
      assigned: acc.assigned + s.total_assigned,
      completed: acc.completed + s.completed,
      failed: acc.failed + s.failed,
      inProgress: acc.inProgress + s.in_progress,
      slaMet: acc.slaMet + s.sla_met_count,
      slaMissed: acc.slaMissed + s.sla_missed_count,
    }),
    { assigned: 0, completed: 0, failed: 0, inProgress: 0, slaMet: 0, slaMissed: 0 }
  );

  const overallSlaRate = totals.completed > 0
    ? Math.round((totals.slaMet / totals.completed) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className={`border-b px-4 py-2 text-center text-xs font-semibold tracking-wide ${getClassificationColor('internal')}`}>
        {getClassificationLabel('internal')}
      </div>

      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3">
              <Link href="/admin" className="text-gray-400 hover:text-gray-600 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </Link>
              <h1 className="text-2xl font-bold text-gray-900">Expert Management</h1>
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-700">Admin</span>
            </div>
            <p className="text-gray-600 mt-1 ml-8">IRS Practitioner performance and management</p>
          </div>
          <button
            onClick={() => setShowInvite(!showInvite)}
            className="bg-emerald-500 text-white px-4 py-2 rounded-lg font-medium hover:bg-emerald-600 transition-colors text-sm"
          >
            + Invite Expert
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* Invite Form (collapsible) */}
        {showInvite && (
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Invite IRS Practitioner</h3>
            <InviteUserForm internalMode defaultRole="expert" />
          </div>
        )}

        {/* Summary Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="bg-white rounded-lg shadow p-4">
            <p className="text-gray-500 text-xs font-medium">Total Experts</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{stats.length}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <p className="text-gray-500 text-xs font-medium">Active Assignments</p>
            <p className="text-2xl font-bold text-blue-600 mt-1">{totals.inProgress}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <p className="text-gray-500 text-xs font-medium">Completed</p>
            <p className="text-2xl font-bold text-green-600 mt-1">{totals.completed}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <p className="text-gray-500 text-xs font-medium">Failed</p>
            <p className="text-2xl font-bold text-red-600 mt-1">{totals.failed}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <p className="text-gray-500 text-xs font-medium">SLA Compliance</p>
            <p className={`text-2xl font-bold mt-1 ${overallSlaRate >= 90 ? 'text-green-600' : overallSlaRate >= 70 ? 'text-yellow-600' : 'text-red-600'}`}>
              {overallSlaRate}%
            </p>
          </div>
        </div>

        {/* Expert Performance Table */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Expert Performance</h2>
          </div>

          {stats.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Expert</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-gray-700 uppercase">Total</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-gray-700 uppercase">Active</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-gray-700 uppercase">Completed</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-gray-700 uppercase">Failed</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-gray-700 uppercase">Completion</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-gray-700 uppercase">SLA Met</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-gray-700 uppercase">SLA %</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-gray-700 uppercase">Avg Hours</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {stats
                    .sort((a, b) => b.total_assigned - a.total_assigned)
                    .map((expert) => (
                      <tr key={expert.expert_id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4">
                          <div>
                            <p className="text-sm font-semibold text-gray-900">{expert.expert_name}</p>
                            <p className="text-xs text-gray-500">{expert.expert_email}</p>
                          </div>
                        </td>
                        <td className="px-4 py-4 text-center text-sm text-gray-700">{expert.total_assigned}</td>
                        <td className="px-4 py-4 text-center">
                          <span className={`text-sm font-medium ${expert.in_progress > 0 ? 'text-blue-600' : 'text-gray-400'}`}>
                            {expert.in_progress}
                          </span>
                        </td>
                        <td className="px-4 py-4 text-center">
                          <span className="text-sm font-medium text-green-600">{expert.completed}</span>
                        </td>
                        <td className="px-4 py-4 text-center">
                          <span className={`text-sm font-medium ${expert.failed > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                            {expert.failed}
                          </span>
                        </td>
                        <td className="px-4 py-4 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <div className="w-16 bg-gray-200 rounded-full h-1.5">
                              <div
                                className="bg-emerald-500 h-1.5 rounded-full"
                                style={{ width: `${expert.completion_rate}%` }}
                              />
                            </div>
                            <span className="text-xs font-medium text-gray-600">{expert.completion_rate}%</span>
                          </div>
                        </td>
                        <td className="px-4 py-4 text-center text-sm text-gray-700">
                          {expert.sla_met_count}/{expert.sla_met_count + expert.sla_missed_count}
                        </td>
                        <td className="px-4 py-4 text-center">
                          <span className={`text-sm font-semibold ${
                            expert.sla_compliance_rate >= 90 ? 'text-green-600' :
                            expert.sla_compliance_rate >= 70 ? 'text-yellow-600' :
                            'text-red-600'
                          }`}>
                            {expert.completed > 0 ? `${expert.sla_compliance_rate}%` : '—'}
                          </span>
                        </td>
                        <td className="px-4 py-4 text-center text-sm text-gray-700">
                          {expert.avg_completion_hours > 0 ? `${expert.avg_completion_hours}h` : '—'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-6 py-12 text-center">
              <p className="text-gray-500 font-medium mb-2">No experts yet</p>
              <p className="text-gray-400 text-sm">Invite IRS practitioners to get started.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
