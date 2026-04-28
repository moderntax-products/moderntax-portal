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

export const revalidate = 15;

interface StatusPayload {
  updated_at: string;
  current_wait_minutes: number | null;
  lifetime_avg_hold_minutes: number | null;
  lifetime_calls_completed: number;
  last_call: {
    ended_at: string;
    hold_minutes: number | null;
    duration_minutes: number | null;
    status: string;
    entities: number;
  } | null;
}

async function fetchInitialStatus(): Promise<StatusPayload | null> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  try {
    const res = await fetch(`${baseUrl}/api/public/status`, { next: { revalidate: 15 } });
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
