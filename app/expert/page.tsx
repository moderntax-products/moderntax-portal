'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase';
import { ExpertAssignmentCard } from '@/components/ExpertAssignmentCard';
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
    request_id: string;
  };
}

export default function ExpertDashboard() {
  const [assignments, setAssignments] = useState<AssignmentData[]>([]);
  const [completedToday, setCompletedToday] = useState<AssignmentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [profile, setProfile] = useState<{ full_name: string | null; role: string } | null>(null);
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
      const { data: profileData } = await supabase
        .from('profiles')
        .select('full_name, role')
        .eq('id', user.id)
        .single();

      if (!profileData || profileData.role !== 'expert') {
        router.push('/');
        return;
      }

      setProfile(profileData);

      // Fetch active assignments
      const { data: activeData, error: activeError } = await supabase
        .from('expert_assignments')
        .select('*, request_entities(id, entity_name, tid, tid_kind, form_type, years, signed_8821_url, request_id)')
        .in('status', ['assigned', 'in_progress'])
        .eq('expert_id', user.id)
        .order('sla_deadline', { ascending: true });

      if (activeError) {
        console.error('Failed to fetch assignments:', activeError);
        setError('Failed to load assignments');
        return;
      }

      setAssignments((activeData as AssignmentData[]) || []);

      // Fetch completed today
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const { data: completedData } = await supabase
        .from('expert_assignments')
        .select('*, request_entities(id, entity_name, tid, tid_kind, form_type, years, signed_8821_url, request_id)')
        .eq('status', 'completed')
        .eq('expert_id', user.id)
        .gte('completed_at', todayStart.toISOString())
        .order('completed_at', { ascending: false });

      setCompletedToday((completedData as AssignmentData[]) || []);
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

  // Calculate SLA stats from completed today
  const slaMetCount = completedToday.filter((a) => a.sla_met === true).length;
  const slaTotalCompleted = completedToday.filter((a) => a.sla_met !== null).length;
  const slaRate = slaTotalCompleted > 0 ? Math.round((slaMetCount / slaTotalCompleted) * 100) : 100;

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
          <button
            onClick={fetchData}
            className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Refresh
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
            <div className="text-2xl font-bold text-blue-600">{assignments.length}</div>
            <div className="text-xs text-gray-500 uppercase tracking-wide">Active</div>
          </div>
          <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
            <div className="text-2xl font-bold text-emerald-600">{completedToday.length}</div>
            <div className="text-xs text-gray-500 uppercase tracking-wide">Completed Today</div>
          </div>
          <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
            <div className="text-2xl font-bold text-amber-600">{slaRate}%</div>
            <div className="text-xs text-gray-500 uppercase tracking-wide">SLA Compliance</div>
          </div>
        </div>

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

        {/* Completed Today */}
        {completedToday.length > 0 && (
          <div className="mt-8 space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">
              Completed Today ({completedToday.length})
            </h2>
            {completedToday.map((assignment) => (
              <div
                key={assignment.id}
                className="bg-white border border-gray-200 rounded-lg p-4 flex items-center justify-between"
              >
                <div>
                  <span className="font-medium text-gray-900">
                    {assignment.request_entities.entity_name}
                  </span>
                  <span className="ml-2 text-xs text-gray-500">
                    {assignment.request_entities.form_type} | {assignment.request_entities.years.join(', ')}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${assignment.sla_met ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                    SLA {assignment.sla_met ? 'Met' : 'Missed'}
                  </span>
                  <span className="text-xs text-gray-500">
                    {assignment.completed_at
                      ? new Date(assignment.completed_at).toLocaleTimeString()
                      : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
