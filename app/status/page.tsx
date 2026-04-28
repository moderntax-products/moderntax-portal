/**
 * /status — Public IRS pull status page.
 *
 * Customer-facing, no auth. Shows the current IRS Practitioner Priority
 * Service wait time + ModernTax throughput (calls in flight, entities
 * delivered today, 7d success rate). Auto-refreshes every 60 seconds.
 *
 * The same page Stripe / Notion / etc. style "status.example.com" pages
 * serve — gives customers visibility into "is the IRS slow today?"
 * without having to email support. Acts as a live answer to "where's
 * my transcript?" — they can see if the queue is congested or if an
 * outage is in progress.
 *
 * Cached at the edge for 60 seconds so a public refresh storm doesn't
 * touch the DB. Server component shell + a client child for live
 * polling refresh.
 */

import { StatusPageClient } from '@/components/StatusPageClient';

export const metadata = {
  title: 'IRS Pull Status — ModernTax',
  description: 'Real-time IRS Practitioner Priority Service wait times and ModernTax pull throughput.',
};

export const revalidate = 60;

interface StatusPayload {
  updated_at: string;
  live: { active_calls: number; calls_on_hold: number; experts_active: number };
  wait_times: { avg_hold_minutes_today: number | null; avg_hold_minutes_7d: number | null; median_hold_minutes_7d: number | null };
  throughput: {
    entities_completed_today: number;
    entities_completed_7d: number;
    calls_completed_today: number;
    calls_completed_7d: number;
    success_rate_7d: number;
  };
  recent: { ended_at: string; duration_minutes: number | null; hold_minutes: number | null; status: string; entities: number }[];
}

async function fetchInitialStatus(): Promise<StatusPayload | null> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  try {
    const res = await fetch(`${baseUrl}/api/public/status`, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    return (await res.json()) as StatusPayload;
  } catch {
    return null;
  }
}

export default async function StatusPage() {
  const initial = await fetchInitialStatus();
  return <StatusPageClient initial={initial} />;
}
