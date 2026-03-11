import { NextResponse } from 'next/server';
import { createServerComponentClient } from '@/lib/supabase-server';
import type { ExpertPerformanceStats } from '@/lib/types';

export async function GET() {
  const supabase = await createServerComponentClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check admin role
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null; error: any };

  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Fetch all experts
  const { data: experts } = await supabase
    .from('profiles')
    .select('id, email, full_name')
    .eq('role', 'expert') as { data: { id: string; email: string; full_name: string | null }[] | null; error: any };

  if (!experts || experts.length === 0) {
    return NextResponse.json({ stats: [] });
  }

  // Fetch all assignments
  const { data: assignments } = await supabase
    .from('expert_assignments')
    .select('*')
    .in('expert_id', experts.map((e) => e.id)) as { data: any[] | null; error: any };

  // Build per-expert stats
  const stats: ExpertPerformanceStats[] = experts.map((expert) => {
    const expertAssignments = (assignments || []).filter((a: any) => a.expert_id === expert.id);
    const completed = expertAssignments.filter((a: any) => a.status === 'completed');
    const failed = expertAssignments.filter((a: any) => a.status === 'failed');
    const inProgress = expertAssignments.filter((a: any) => ['assigned', 'in_progress'].includes(a.status));
    const slaMet = completed.filter((a: any) => a.sla_met === true);
    const slaMissed = completed.filter((a: any) => a.sla_met === false);

    // Calculate average completion time in hours
    let avgCompletionHours = 0;
    if (completed.length > 0) {
      const totalHours = completed.reduce((sum: number, a: any) => {
        const assigned = new Date(a.assigned_at).getTime();
        const completedAt = new Date(a.completed_at).getTime();
        return sum + (completedAt - assigned) / (1000 * 60 * 60);
      }, 0);
      avgCompletionHours = Math.round((totalHours / completed.length) * 10) / 10;
    }

    const totalNonReassigned = expertAssignments.filter((a: any) => a.status !== 'reassigned').length;

    return {
      expert_id: expert.id,
      expert_name: expert.full_name || expert.email,
      expert_email: expert.email,
      total_assigned: totalNonReassigned,
      completed: completed.length,
      failed: failed.length,
      in_progress: inProgress.length,
      sla_met_count: slaMet.length,
      sla_missed_count: slaMissed.length,
      avg_completion_hours: avgCompletionHours,
      completion_rate: totalNonReassigned > 0 ? Math.round((completed.length / totalNonReassigned) * 100) : 0,
      sla_compliance_rate: completed.length > 0 ? Math.round((slaMet.length / completed.length) * 100) : 0,
    };
  });

  return NextResponse.json({ stats });
}
