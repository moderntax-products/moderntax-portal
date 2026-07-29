/**
 * /admin/compliance-audit — the Compliance Audit board.
 *
 * Sweeps every entity's stored transcript intelligence, surfaces the ones with
 * an open IRS compliance issue (ranked by exposure), and lets the team turn any
 * case into a bespoke, billable-hour resolution engagement with a custom Stripe
 * payment link (no fixed SKU). Admin only.
 *
 * Matt 2026-07-28.
 */

import { redirect } from 'next/navigation';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';
import { auditEntities, summarizeAudit, type AuditRow } from '@/lib/compliance-audit';
import { PRICE_RESOLUTION_HOURLY_DEFAULT } from '@/lib/pricing';
import ComplianceAuditBoard from '@/components/ComplianceAuditBoard';

export const dynamic = 'force-dynamic';

export default async function ComplianceAuditPage() {
  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: adminProfile } = await supabase.from('profiles').select('role').eq('id', user.id).single() as {
    data: { role: string } | null;
  };
  if (!adminProfile || adminProfile.role !== 'admin') redirect('/');

  // Sweep every entity (service role — the audit spans all clients).
  const admin = createAdminClient();
  const rows: AuditRow[] = [];
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await admin
      .from('request_entities')
      .select('id, entity_name, tid, form_type, status, compliance_score, gross_receipts, requests(client_id, clients(name))')
      .range(from, from + 999) as { data: any[] | null; error: any };
    if (error || !data) break;
    rows.push(...(data as AuditRow[]));
    if (data.length < 1000) break;
    from += 1000;
  }

  const cases = auditEntities(rows);
  const summary = summarizeAudit(cases);

  return (
    <ComplianceAuditBoard
      cases={cases}
      summary={summary}
      scanned={rows.length}
      defaultRate={PRICE_RESOLUTION_HOURLY_DEFAULT}
    />
  );
}
