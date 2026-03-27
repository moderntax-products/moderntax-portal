import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import Link from 'next/link';
import { getClassificationLabel, getClassificationColor } from '@/lib/mask';
import { BillingSettingsForm } from '@/components/BillingSettingsForm';

interface PageProps {
  searchParams: Promise<{ month?: string }>;
}

export default async function InvoicingPage({ searchParams }: PageProps) {
  const { month: selectedMonth } = await searchParams;
  const supabase = await createServerComponentClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, client_id, full_name')
    .eq('id', user.id)
    .single() as { data: { role: string; client_id: string | null; full_name: string | null } | null; error: any };

  if (!profile || profile.role !== 'manager' || !profile.client_id) {
    redirect('/');
  }

  // Get client with billing settings
  const { data: client } = await supabase
    .from('clients')
    .select('id, name, slug, free_trial, intake_methods, billing_payment_method, billing_ap_email, billing_ap_phone, billing_rate_pdf, billing_rate_csv')
    .eq('id', profile.client_id)
    .single() as { data: any | null; error: any };

  if (!client) redirect('/');

  const ratePdf = client.billing_rate_pdf || 59.98;
  const rateCsv = client.billing_rate_csv || 69.98;

  // Get all client requests with entities
  const { data: allRequests } = await supabase
    .from('requests')
    .select('id, loan_number, intake_method, requested_by, created_at, request_entities(id, entity_name, tid, tid_kind, form_type, status, completed_at)')
    .eq('client_id', profile.client_id)
    .order('created_at', { ascending: false }) as { data: any[] | null; error: any };

  // Get team profiles for processor names
  const { data: teamProfiles } = await supabase
    .from('profiles')
    .select('id, full_name, email')
    .eq('client_id', profile.client_id) as { data: { id: string; full_name: string | null; email: string }[] | null; error: any };

  const nameMap: Record<string, string> = {};
  (teamProfiles || []).forEach((p) => { nameMap[p.id] = p.full_name || p.email; });

  // Build all completed entities with metadata
  const allCompletedEntities: {
    id: string;
    entity_name: string;
    tid: string;
    tid_kind: string;
    form_type: string;
    completed_at: string;
    loan_number: string;
    intake_method: string;
    processor: string;
    rate: number;
    month: string; // YYYY-MM
  }[] = [];

  (allRequests || []).forEach((req: any) => {
    (req.request_entities || []).forEach((entity: any) => {
      if (entity.status === 'completed' && entity.completed_at) {
        const completedDate = new Date(entity.completed_at);
        const monthKey = `${completedDate.getFullYear()}-${String(completedDate.getMonth() + 1).padStart(2, '0')}`;
        const rate = req.intake_method === 'csv' ? rateCsv : ratePdf;
        allCompletedEntities.push({
          id: entity.id,
          entity_name: entity.entity_name,
          tid: entity.tid,
          tid_kind: entity.tid_kind,
          form_type: entity.form_type,
          completed_at: entity.completed_at,
          loan_number: req.loan_number,
          intake_method: req.intake_method,
          processor: nameMap[req.requested_by] || 'Unknown',
          rate,
          month: monthKey,
        });
      }
    });
  });

  // Free trial: exclude first 3 entities (account-level)
  let freeEntityIds = new Set<string>();
  if (client.free_trial) {
    const sorted = [...allCompletedEntities].sort(
      (a, b) => new Date(a.completed_at).getTime() - new Date(b.completed_at).getTime()
    );
    freeEntityIds = new Set(sorted.slice(0, 3).map((e) => e.id));
  }

  // Get available months (sorted newest first)
  const availableMonths = [...new Set(allCompletedEntities.map((e) => e.month))].sort().reverse();

  // Default to latest month
  const activeMonth = selectedMonth || availableMonths[0] || null;

  // Filter entities for selected month
  const monthEntities = activeMonth
    ? allCompletedEntities.filter((e) => e.month === activeMonth)
    : [];

  // Calculate totals for selected month
  const billableEntities = monthEntities.filter((e) => !freeEntityIds.has(e.id));
  const freeEntities = monthEntities.filter((e) => freeEntityIds.has(e.id));
  const monthTotal = billableEntities.reduce((sum, e) => sum + e.rate, 0);

  // Group by processor
  const byProcessor: Record<string, { name: string; entities: typeof monthEntities; total: number }> = {};
  monthEntities.forEach((e) => {
    if (!byProcessor[e.processor]) {
      byProcessor[e.processor] = { name: e.processor, entities: [], total: 0 };
    }
    byProcessor[e.processor].entities.push(e);
    if (!freeEntityIds.has(e.id)) {
      byProcessor[e.processor].total += e.rate;
    }
  });

  // Group by loan number
  const byLoan: Record<string, { loan_number: string; entities: typeof monthEntities; total: number }> = {};
  monthEntities.forEach((e) => {
    if (!byLoan[e.loan_number]) {
      byLoan[e.loan_number] = { loan_number: e.loan_number, entities: [], total: 0 };
    }
    byLoan[e.loan_number].entities.push(e);
    if (!freeEntityIds.has(e.id)) {
      byLoan[e.loan_number].total += e.rate;
    }
  });

  // Get invoices for this client
  const { data: invoices } = await supabase
    .from('invoices')
    .select('*')
    .eq('client_id', profile.client_id)
    .order('billing_period_start', { ascending: false }) as { data: any[] | null; error: any };

  // Find invoice for active month
  const activeInvoice = activeMonth
    ? (invoices || []).find((inv: any) => inv.billing_period_start?.startsWith(activeMonth))
    : null;

  const formatMonth = (monthKey: string) => {
    const [y, m] = monthKey.split('-');
    const date = new Date(parseInt(y), parseInt(m) - 1);
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'paid': return 'bg-green-100 text-green-800';
      case 'sent': return 'bg-blue-100 text-blue-800';
      case 'overdue': return 'bg-red-100 text-red-800';
      default: return 'bg-gray-100 text-gray-600';
    }
  };

  const maskTid = (tid: string, kind: string) => {
    if (kind === 'EIN' && tid.length >= 4) {
      return `XX-XXX${tid.slice(-4)}`;
    }
    if (tid.length >= 4) {
      return `XXX-XX-${tid.slice(-4)}`;
    }
    return tid;
  };

  const billingSetup = client.billing_payment_method && client.billing_ap_email;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* SOC 2 Banner */}
      <div className={`border-b px-4 py-2 text-center text-xs font-semibold tracking-wide ${getClassificationColor('confidential')}`}>
        {getClassificationLabel('confidential')}
      </div>

      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-mt-dark">Invoicing</h1>
            <p className="text-gray-600 mt-1">{client.name} — Billing & Payment History</p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Dashboard
            </Link>
            <Link
              href="/team"
              className="px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              My Team
            </Link>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Billing Settings Card */}
        <div className="bg-white rounded-lg shadow mb-8">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-mt-dark">Payment Settings</h2>
            {billingSetup ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-800">
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                Configured
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
                Setup Required
              </span>
            )}
          </div>
          <div className="p-6">
            <BillingSettingsForm
              initialPaymentMethod={client.billing_payment_method || ''}
              initialApEmail={client.billing_ap_email || ''}
              initialApPhone={client.billing_ap_phone || ''}
            />
          </div>
        </div>

        {/* Month Selector */}
        {availableMonths.length > 0 ? (
          <>
            <div className="flex items-center gap-3 mb-6">
              <label className="text-sm font-medium text-gray-700">Billing Period:</label>
              <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
                {availableMonths.map((m) => (
                  <Link
                    key={m}
                    href={`/invoicing?month=${m}`}
                    className={`px-4 py-2 font-medium transition-colors border-l first:border-l-0 border-gray-300 ${
                      m === activeMonth
                        ? 'bg-mt-dark text-white'
                        : 'bg-white text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {formatMonth(m)}
                  </Link>
                ))}
              </div>
            </div>

            {/* Invoice Summary */}
            {activeMonth && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                  <div className="bg-white rounded-lg shadow p-6">
                    <p className="text-gray-600 text-sm font-medium">Completed Entities</p>
                    <p className="text-3xl font-bold text-mt-dark mt-2">{monthEntities.length}</p>
                  </div>
                  <div className="bg-white rounded-lg shadow p-6">
                    <p className="text-gray-600 text-sm font-medium">Billable</p>
                    <p className="text-3xl font-bold text-mt-dark mt-2">{billableEntities.length}</p>
                    {freeEntities.length > 0 && (
                      <p className="text-xs text-green-600 mt-1">{freeEntities.length} free (trial)</p>
                    )}
                  </div>
                  <div className="bg-white rounded-lg shadow p-6">
                    <p className="text-gray-600 text-sm font-medium">Total Amount</p>
                    <p className="text-3xl font-bold text-mt-dark mt-2">
                      ${monthTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                  </div>
                  <div className="bg-white rounded-lg shadow p-6">
                    <p className="text-gray-600 text-sm font-medium">Payment Status</p>
                    {activeInvoice ? (
                      <div className="mt-2">
                        <span className={`inline-block px-3 py-1 rounded-full text-sm font-semibold ${getStatusBadge(activeInvoice.status)}`}>
                          {activeInvoice.status.charAt(0).toUpperCase() + activeInvoice.status.slice(1)}
                        </span>
                        {activeInvoice.due_date && activeInvoice.status !== 'paid' && (
                          <p className="text-xs text-gray-500 mt-1">Due: {formatDate(activeInvoice.due_date)}</p>
                        )}
                        {activeInvoice.paid_at && (
                          <p className="text-xs text-green-600 mt-1">Paid: {formatDate(activeInvoice.paid_at)}</p>
                        )}
                      </div>
                    ) : (
                      <p className="text-2xl font-bold text-gray-400 mt-2">—</p>
                    )}
                  </div>
                </div>

                {/* Breakdown by Processor */}
                {Object.keys(byProcessor).length > 0 && (
                  <div className="bg-white rounded-lg shadow overflow-hidden mb-8">
                    <div className="px-6 py-4 border-b border-gray-200">
                      <h2 className="text-lg font-semibold text-mt-dark">By Processor</h2>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead className="bg-gray-50 border-b border-gray-200">
                          <tr>
                            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Processor</th>
                            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Entities</th>
                            <th className="px-6 py-3 text-right text-sm font-semibold text-gray-700">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                          {Object.values(byProcessor)
                            .sort((a, b) => b.total - a.total)
                            .map((proc) => (
                              <tr key={proc.name} className="hover:bg-gray-50">
                                <td className="px-6 py-4 text-sm font-semibold text-mt-dark">{proc.name}</td>
                                <td className="px-6 py-4 text-sm text-gray-600">{proc.entities.length}</td>
                                <td className="px-6 py-4 text-sm font-semibold text-gray-900 text-right">
                                  ${proc.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </td>
                              </tr>
                            ))}
                          <tr className="bg-gray-50 font-semibold">
                            <td className="px-6 py-3 text-sm text-mt-dark">TOTAL</td>
                            <td className="px-6 py-3 text-sm text-gray-900">{monthEntities.length}</td>
                            <td className="px-6 py-3 text-sm text-gray-900 text-right">
                              ${monthTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Breakdown by Loan Number */}
                {Object.keys(byLoan).length > 0 && (
                  <div className="bg-white rounded-lg shadow overflow-hidden mb-8">
                    <div className="px-6 py-4 border-b border-gray-200">
                      <h2 className="text-lg font-semibold text-mt-dark">By Loan Number</h2>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead className="bg-gray-50 border-b border-gray-200">
                          <tr>
                            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Loan #</th>
                            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Entity</th>
                            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">EIN/SSN</th>
                            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Form</th>
                            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Completed</th>
                            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Source</th>
                            <th className="px-6 py-3 text-right text-sm font-semibold text-gray-700">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                          {Object.values(byLoan)
                            .sort((a, b) => b.total - a.total)
                            .flatMap((loan) =>
                              loan.entities.map((entity, idx) => (
                                <tr key={entity.id} className="hover:bg-gray-50">
                                  <td className="px-6 py-3">
                                    {idx === 0 ? (
                                      <code className="text-sm font-mono text-mt-dark">{loan.loan_number}</code>
                                    ) : null}
                                  </td>
                                  <td className="px-6 py-3 text-sm text-gray-700">{entity.entity_name}</td>
                                  <td className="px-6 py-3 text-sm text-gray-500 font-mono">
                                    {maskTid(entity.tid, entity.tid_kind)}
                                  </td>
                                  <td className="px-6 py-3">
                                    <span className="text-xs font-medium px-2 py-0.5 rounded bg-gray-100 text-gray-600">
                                      {entity.form_type}
                                    </span>
                                  </td>
                                  <td className="px-6 py-3 text-sm text-gray-600">
                                    {formatDate(entity.completed_at)}
                                  </td>
                                  <td className="px-6 py-3">
                                    <span className="text-xs font-medium px-2 py-0.5 rounded bg-gray-100 text-gray-600">
                                      {entity.intake_method.toUpperCase()}
                                    </span>
                                  </td>
                                  <td className="px-6 py-3 text-sm text-right">
                                    {freeEntityIds.has(entity.id) ? (
                                      <span className="text-green-600 font-medium">Free</span>
                                    ) : (
                                      <span className="font-semibold text-gray-900">
                                        ${entity.rate.toFixed(2)}
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              ))
                            )}
                          <tr className="bg-gray-50 font-semibold">
                            <td className="px-6 py-3 text-sm text-mt-dark" colSpan={6}>TOTAL</td>
                            <td className="px-6 py-3 text-sm text-gray-900 text-right">
                              ${monthTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Invoice History */}
                {invoices && invoices.length > 0 && (
                  <div className="bg-white rounded-lg shadow overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-200">
                      <h2 className="text-lg font-semibold text-mt-dark">Invoice History</h2>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead className="bg-gray-50 border-b border-gray-200">
                          <tr>
                            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Invoice #</th>
                            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Period</th>
                            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Entities</th>
                            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Amount</th>
                            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Status</th>
                            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Due Date</th>
                            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Payment</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                          {(invoices || []).map((inv: any) => (
                            <tr key={inv.id} className="hover:bg-gray-50">
                              <td className="px-6 py-4 text-sm font-mono text-mt-dark">{inv.invoice_number}</td>
                              <td className="px-6 py-4 text-sm text-gray-600">
                                {formatMonth(inv.billing_period_start.slice(0, 7))}
                              </td>
                              <td className="px-6 py-4 text-sm text-gray-600">{inv.total_entities}</td>
                              <td className="px-6 py-4 text-sm font-semibold text-gray-900">
                                ${Number(inv.total_amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                              <td className="px-6 py-4">
                                <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${getStatusBadge(inv.status)}`}>
                                  {inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}
                                </span>
                              </td>
                              <td className="px-6 py-4 text-sm text-gray-600">
                                {inv.due_date ? formatDate(inv.due_date) : '—'}
                              </td>
                              <td className="px-6 py-4 text-sm text-gray-500">
                                {inv.payment_method ? inv.payment_method.toUpperCase() : '—'}
                                {inv.mercury_reference && (
                                  <span className="text-xs text-gray-400 block">Ref: {inv.mercury_reference}</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <div className="bg-white rounded-lg shadow px-6 py-12 text-center">
            <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
            </svg>
            <p className="text-gray-500 font-medium mb-2">No completed requests yet</p>
            <p className="text-gray-400 text-sm">Invoices will appear here once requests are completed.</p>
          </div>
        )}
      </div>
    </div>
  );
}
