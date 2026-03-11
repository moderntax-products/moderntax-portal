'use client';

import { useEffect, useState } from 'react';

interface SlaCountdownProps {
  slaDeadline: string;
}

export function SlaCountdown({ slaDeadline }: SlaCountdownProps) {
  const [remaining, setRemaining] = useState<{ hours: number; minutes: number } | null>(null);
  const [overdue, setOverdue] = useState(false);

  useEffect(() => {
    const update = () => {
      const deadline = new Date(slaDeadline).getTime();
      const now = Date.now();
      const diff = deadline - now;

      if (diff <= 0) {
        const overdueMs = Math.abs(diff);
        const hours = Math.floor(overdueMs / (1000 * 60 * 60));
        const minutes = Math.floor((overdueMs % (1000 * 60 * 60)) / (1000 * 60));
        setRemaining({ hours, minutes });
        setOverdue(true);
      } else {
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        setRemaining({ hours, minutes });
        setOverdue(false);
      }
    };

    update();
    const interval = setInterval(update, 60000); // Update every minute
    return () => clearInterval(interval);
  }, [slaDeadline]);

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
