import { NextResponse } from 'next/server';
import { createServerComponentClient } from '@/lib/supabase-server';
import type { ExpertPerformanceStats } from '@/lib/types';
import { businessHoursElapsed, isOverdue, SLA_DEFAULTS } from '@/lib/expert-sla';

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

  // Fetch all experts (include their iana_timezone for business-hours math)
  const { data: experts } = await supabase
    .from('profiles')
    .select('id, email, full_name, iana_timezone')
    .eq('role', 'expert') as { data: { id: string; email: string; full_name: string | null; iana_timezone: string | null }[] | null; error: any };

  if (!experts || experts.length === 0) {
    return NextResponse.json({ stats: [] });
  }

  // Fetch all assignments
  const { data: assignments } = await supabase
    .from('expert_assignments')
    .select('*')
    .in('expert_id', experts.map((e) => e.id)) as { data: any[] | null; error: any };

  // Build per-expert stats. Turnaround + SLA compliance are computed in
  // BUSINESS HOURS (Mon–Fri 7am–7pm in expert tz) per the matt 2026-04-27
  // SLA clock directive — see lib/expert-sla.ts.
  const nowMs = Date.now();
  const stats: ExpertPerformanceStats[] = experts.map((expert) => {
    const expertTz = expert.iana_timezone || SLA_DEFAULTS.EXPERT_TZ;
    const expertAssignments = (assignments || []).filter((a: any) => a.expert_id === expert.id);
    const completed = expertAssignments.filter((a: any) => a.status === 'completed');
    const failed = expertAssignments.filter((a: any) => a.status === 'failed');
    const inProgress = expertAssignments.filter((a: any) => ['assigned', 'in_progress'].includes(a.status));

    // SLA compliance: re-derived live from business-hours clock instead
    // of trusting the stored sla_met boolean (which used naive wall-clock
    // math under the old system). For completed rows, SLA was met iff
    // completed_at - clock_started_at (business hours) <= sla budget.
    const slaMet = completed.filter((a: any) => {
      if (!a.expert_clock_started_at || !a.completed_at) return a.sla_met === true;
      const startedMs = new Date(a.expert_clock_started_at).getTime();
      const completedMs = new Date(a.completed_at).getTime();
      const elapsed = businessHoursElapsed(startedMs, completedMs, expertTz);
      const budget = a.sla_business_hours ?? SLA_DEFAULTS.DEFAULT_SLA_BUSINESS_HOURS;
      return elapsed <= budget;
    });
    const slaMissed = completed.filter((a: any) => !slaMet.includes(a));

    // Average completion time in BUSINESS hours, only counting assignments
    // where the clock actually ran (expert_clock_started_at present).
    let avgCompletionHours = 0;
    const completedWithClock = completed.filter((a: any) => a.expert_clock_started_at && a.completed_at);
    if (completedWithClock.length > 0) {
      const totalHours = completedWithClock.reduce((sum: number, a: any) => {
        const startedMs = new Date(a.expert_clock_started_at).getTime();
        const completedMs = new Date(a.completed_at).getTime();
        return sum + businessHoursElapsed(startedMs, completedMs, expertTz);
      }, 0);
      avgCompletionHours = Math.round((totalHours / completedWithClock.length) * 10) / 10;
    } else if (completed.length > 0) {
      // Fallback for rows that pre-date the SLA clock migration: use
      // legacy assigned_at → completed_at wall-clock math so the panel
      // doesn't go blank for historical data.
      const totalHours = completed.reduce((sum: number, a: any) => {
        const assigned = new Date(a.assigned_at).getTime();
        const completedAt = new Date(a.completed_at).getTime();
        return sum + (completedAt - assigned) / (1000 * 60 * 60);
      }, 0);
      avgCompletionHours = Math.round((totalHours / completed.length) * 10) / 10;
    }

    // In-progress overdue count using live business-hours clock
    const overdueInProgress = inProgress.filter((a: any) => {
      if (!a.expert_clock_started_at) return false;
      const startedMs = new Date(a.expert_clock_started_at).getTime();
      const slaHours = a.sla_business_hours ?? SLA_DEFAULTS.DEFAULT_SLA_BUSINESS_HOURS;
      return isOverdue(startedMs, slaHours, expertTz, nowMs);
    }).length;

    const totalNonReassigned = expertAssignments.filter((a: any) => a.status !== 'reassigned').length;

    return {
      expert_id: expert.id,
      expert_name: expert.full_name || expert.email,
      expert_email: expert.email,
      total_assigned: totalNonReassigned,
      completed: completed.length,
      failed: failed.length,
      in_progress: inProgress.length,
      overdue_in_progress: overdueInProgress,
      sla_met_count: slaMet.length,
      sla_missed_count: slaMissed.length,
      avg_completion_hours: avgCompletionHours,
      completion_rate: totalNonReassigned > 0 ? Math.round((completed.length / totalNonReassigned) * 100) : 0,
      sla_compliance_rate: completed.length > 0 ? Math.round((slaMet.length / completed.length) * 100) : 0,
    };
  });

  return NextResponse.json({ stats });
}
