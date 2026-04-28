/**
 * /expert/timesheet — server-component shell that gates expert role + renders
 * the live timesheet client component. The client handles clock-in/out
 * polling so the running clock stays accurate without a server round-trip.
 */

import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import { ExpertTimesheetClient } from '@/components/ExpertTimesheetClient';

export const metadata = {
  title: 'Timesheet | ModernTax Expert',
};

export default async function ExpertTimesheetPage() {
  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, full_name')
    .eq('id', user.id)
    .single() as { data: { role: string; full_name: string | null } | null; error: any };

  if (!profile) redirect('/login');
  // Allow expert (own timesheet) AND admin (QA / payroll review preview).
  // Admin viewers see the page UI but the API returns empty data for
  // their own user since they have no time logs — fine for walkthrough.
  if (!['expert', 'admin'].includes(profile.role)) redirect('/');

  return <ExpertTimesheetClient expertName={profile.full_name} />;
}
