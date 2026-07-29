'use client';

import { useEffect, useState } from 'react';
import { businessHoursElapsed, SLA_DEFAULTS } from '@/lib/expert-sla';

interface SlaCountdownProps {
  slaDeadline: string;
  status?: string;
  slaMet?: boolean | null;
  completedAt?: string | null;
  /**
   * The assigned expert's IANA timezone — MUST match the tz the deadline was
   * computed in (assignment-batch uses expertProfile.iana_timezone). Drives the
   * business-hours window so the clock pauses at the expert's real 7pm–7am.
   * Falls back to the SLA default when unknown.
   */
  expertTz?: string;
}

// Split fractional business hours into {hours, minutes}, guarding the 60→0 roll.
function splitHours(totalHours: number): { hours: number; minutes: number } {
  let hours = Math.floor(totalHours);
  let minutes = Math.round((totalHours - hours) * 60);
  if (minutes >= 60) { hours += 1; minutes = 0; }
  return { hours, minutes };
}

export function SlaCountdown({ slaDeadline, status, slaMet, completedAt, expertTz }: SlaCountdownProps) {
  const tz = expertTz || SLA_DEFAULTS.EXPERT_TZ;
  const [remaining, setRemaining] = useState<{ hours: number; minutes: number } | null>(null);
  const [overdue, setOverdue] = useState(false);

  useEffect(() => {
    const update = () => {
      const deadline = new Date(slaDeadline).getTime();
      const now = Date.now();

      // Show BUSINESS hours remaining, not raw wall-clock. Because business
      // hours don't accrue outside 7am–7pm local or on weekends, this value
      // FREEZES overnight instead of bleeding down — fixing the "clock kept
      // counting down overnight" report. Equivalent to slaBusinessHours minus
      // elapsed, since the deadline was set where elapsed == slaBusinessHours.
      if (now >= deadline) {
        setRemaining(splitHours(businessHoursElapsed(deadline, now, tz)));
        setOverdue(true);
      } else {
        setRemaining(splitHours(businessHoursElapsed(now, deadline, tz)));
        setOverdue(false);
      }
    };

    update();
    const interval = setInterval(update, 60000); // Update every minute
    return () => clearInterval(interval);
  }, [slaDeadline, tz]);

  // For completed assignments, show SLA Met/Missed instead of live countdown
  if (status === 'completed') {
    const met = slaMet !== null ? slaMet : (completedAt ? new Date(completedAt) <= new Date(slaDeadline) : true);
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-xs font-medium ${
        met
          ? 'text-emerald-600 bg-emerald-50 border-emerald-200'
          : 'text-amber-600 bg-amber-50 border-amber-200'
      }`}>
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {met ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          )}
        </svg>
        {met ? 'SLA Met' : 'SLA Missed'}
      </span>
    );
  }

  if (!remaining) return null;

  const totalHoursRemaining = remaining.hours + remaining.minutes / 60;

  let colorClass = 'text-emerald-600 bg-emerald-50 border-emerald-200';
  if (overdue) {
    colorClass = 'text-red-700 bg-red-50 border-red-300 animate-pulse';
  } else if (totalHoursRemaining < 4) {
    colorClass = 'text-red-600 bg-red-50 border-red-200';
  } else if (totalHoursRemaining < 12) {
    colorClass = 'text-amber-600 bg-amber-50 border-amber-200';
  }

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-xs font-medium ${colorClass}`}>
      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {overdue
        ? `Overdue by ${remaining.hours}h ${remaining.minutes}m`
        : `${remaining.hours}h ${remaining.minutes}m remaining`}
    </span>
  );
}
