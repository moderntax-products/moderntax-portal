/**
 * Manager + Processor Compliance Page
 *
 * Surfaces flagged entities for the user's client (admins see all).
 * Each flagged entity gets a "Send template" action that fires a
 * borrower-direct outreach email with embedded Calendly link to book a
 * resolution call with the ModernTax team.
 *
 * Robert/Enterprise Bank Apr 27 ask: "We're trying to tell them exactly
 * how to resolve it because we need the issue resolved." This page is
 * the first surfacing of compliance flags outside the admin role.
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createServerComponentClient } from '@/lib/supabase-server';
import { ComplianceOutreachButton } from '@/components/ComplianceOutreachButton';
import { TEMPLATES, suggestTemplate } from '@/lib/compliance-templates';

export default async function CompliancePage() {
  const supabase = await createServerComponentClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, client_id')
    .eq('id', user.id)
    .single() as { data: { role: string; client_id: string | null } | null; error: any };
  if (!profile) redirect('/');
  if (!['admin', 'manager', 'processor'].includes(profile.role)) redirect('/');

  // Pull flagged entities scoped to the user's client (admins get all).
  let entityQuery = supabase
    .from('request_entities')
    .select(
      'id, entity_name, gross_receipts, signer_email, signer_first_name, signer_last_name, completed_at, ' +
      'requests(id, loan_number, client_id, requested_by, clients(name), profiles!requests_requested_by_fkey(full_name, email))'
    )
    .eq('status', 'completed')
    .not('gross_receipts', 'is', null);
  if (profile.role !== 'admin' && profile.client_id) {
    // Filter via the join — Supabase syntax for nested filter
    entityQuery = entityQuery.eq('requests.client_id', profile.client_id);
  }
  const { data: rawEntities } = await entityQuery as { data: any[] | null; error: any };

  // Reduce to entities with at least one CRITICAL or WARNING flag.
  const entities = (rawEntities || [])
    .filter(e => e.requests) // RLS join filter applied above
    .map((e: any) => {
      const allFlags: { type: string; message: string; severity: string }[] = [];
      let totalExposure = 0;
      for (const v of Object.values(e.gross_receipts || {})) {
        if (v && typeof v === 'object') {
          if (Array.isArray((v as any).flags)) allFlags.push(...(v as any).flags);
          if ((v as any).financials) {
            totalExposure += ((v as any).financials.accountBalance || 0)
              + ((v as any).financials.accruedInterest || 0)
              + ((v as any).financials.accruedPenalty || 0);
          }
        }
      }
      const flagTypes = [...new Set(allFlags.map(f => f.type))];
      const hasCritical = allFlags.some(f => f.severity === 'CRITICAL');
      const suggested = suggestTemplate(allFlags);
      return {
        id: e.id,
        entity_name: e.entity_name,
        signer_email: e.signer_email,
        signer_first_name: e.signer_first_name,
        signer_last_name: e.signer_last_name,
        loan_number: e.requests?.loan_number,
        request_id: e.requests?.id,
        completed_at: e.completed_at,
        all_flags: allFlags,
        flag_types: flagTypes,
        flag_count: allFlags.length,
        has_critical: hasCritical,
        total_exposure: totalExposure,
        suggested_template_id: suggested?.id || null,
        suggested_template_name: suggested?.display_name || null,
        suggested_template_short: suggested?.short_description || null,
      };
    })
    .filter(e => e.flag_count > 0)
    .sort((a, b) => (b.has_critical === a.has_critical ? b.flag_count - a.flag_count : (a.has_critical ? -1 : 1)));

  const totalCritical = entities.filter(e => e.has_critical).length;
  const totalExposure = entities.reduce((sum, e) => sum + (e.total_exposure || 0), 0);
  const fmtMoney = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-mt-dark">Compliance Opportunities</h1>
            <p className="text-gray-600 text-sm mt-1">
              Borrowers with flagged IRS records. Send a template to start the resolution conversation.
            </p>
          </div>
          <Link href="/" className="text-sm text-gray-600 hover:text-gray-900 font-medium">&larr; Back to Dashboard</Link>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Top-line metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          <div className="bg-white rounded-lg shadow p-5 border-l-4 border-red-500">
            <p className="text-xs text-gray-500 uppercase font-semibold">Critical Flags</p>
            <p className="text-3xl font-bold text-red-600 mt-2">{totalCritical}</p>
            <p className="text-xs text-gray-500 mt-1">Liens, levies, unfiled, balance due</p>
          </div>
          <div className="bg-white rounded-lg shadow p-5 border-l-4 border-amber-400">
            <p className="text-xs text-gray-500 uppercase font-semibold">Total Flagged Entities</p>
            <p className="text-3xl font-bold text-amber-600 mt-2">{entities.length}</p>
            <p className="text-xs text-gray-500 mt-1">Across all loans / borrowers</p>
          </div>
          <div className="bg-white rounded-lg shadow p-5 border-l-4 border-mt-green">
            <p className="text-xs text-gray-500 uppercase font-semibold">Total IRS Exposure</p>
            <p className="text-3xl font-bold text-mt-dark mt-2">{fmtMoney(totalExposure)}</p>
            <p className="text-xs text-gray-500 mt-1">Outstanding balances + penalties + interest</p>
          </div>
        </div>

        {/* Empty state */}
        {entities.length === 0 ? (
          <div className="bg-white rounded-lg shadow p-12 text-center">
            <svg className="w-12 h-12 text-emerald-400 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
            </svg>
            <p className="text-gray-700 font-semibold mb-1">No compliance issues flagged</p>
            <p className="text-gray-500 text-sm">All your team&apos;s pulled transcripts are clean. New issues surface here as transcripts arrive.</p>
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-600">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">Borrower</th>
                  <th className="px-4 py-3 text-left font-semibold">Loan</th>
                  <th className="px-4 py-3 text-left font-semibold">Flags</th>
                  <th className="px-4 py-3 text-right font-semibold">IRS Exposure</th>
                  <th className="px-4 py-3 text-left font-semibold">Suggested Outreach</th>
                  <th className="px-4 py-3 text-right font-semibold">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {entities.map((e) => (
                  <tr key={e.id} className={e.has_critical ? 'bg-red-50/30' : ''}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-mt-dark">{e.entity_name}</div>
                      <div className="text-xs text-gray-500">{e.signer_email || 'no email on file'}</div>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <Link href={`/request/${e.request_id}`} className="text-blue-600 hover:underline font-mono">
                        {e.loan_number}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {e.all_flags.slice(0, 3).map((f, i) => (
                          <span
                            key={i}
                            className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${f.severity === 'CRITICAL' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}
                            title={f.message}
                          >
                            {f.type}
                          </span>
                        ))}
                        {e.all_flags.length > 3 && (
                          <span className="text-xs text-gray-400">+{e.all_flags.length - 3} more</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm text-mt-dark">
                      {e.total_exposure > 0 ? fmtMoney(e.total_exposure) : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <div className="font-medium text-mt-dark">{e.suggested_template_name || '—'}</div>
                      <div className="text-gray-500 text-[11px]">{e.suggested_template_short}</div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {e.signer_email && e.suggested_template_id ? (
                        <ComplianceOutreachButton
                          entityId={e.id}
                          entityName={e.entity_name}
                          borrowerEmail={e.signer_email}
                          suggestedTemplateId={e.suggested_template_id}
                          allTemplates={TEMPLATES.map(t => ({ id: t.id, display_name: t.display_name }))}
                        />
                      ) : (
                        <span className="text-xs text-gray-400 italic">
                          {!e.signer_email ? 'no email' : 'no template'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-6 text-xs text-gray-500">
          {entities.length > 0 && (
            <p>Each outreach email includes a 15-minute Calendly link to book a resolution call with the ModernTax team. The borrower books, we resolve.</p>
          )}
        </div>
      </div>
    </div>
  );
}
