/**
 * /admin/payroll — admin payroll dashboard.
 *
 * Server-component shell that gates admin role + delegates the live
 * data display to the AdminPayrollClient (polls /api/admin/payroll for
 * cross-expert summary + close-period + mark-paid actions).
 */

import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import { AdminPayrollClient } from '@/components/AdminPayrollClient';

export const metadata = { title: 'Payroll | Admin' };

export default async function AdminPayrollPage() {
  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null; error: any };
  if (!profile || profile.role !== 'admin') redirect('/');

  return <AdminPayrollClient />;
}
