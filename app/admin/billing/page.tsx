import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import Link from 'next/link';

/**
 * Admin Billing Dashboard
 *
 * Pricing model:
 *   - $59.98/entity with pre-signed 8821 uploaded (PDF intake or reorder)
 *   - $69.98/entity with 8821 signature required (CSV intake)
 *   - $2,499/month fixed for Clearfirm (API intake)
 *   - $39.98/API call for Employer.com (employment product)
 *   - Reorders: flat $59.98 rate
 *   - Free trial: first 3 entities free per client
 */

// Billing rate constants
const RATES = {
  PRE_SIGNED_8821: 59.98,    // PDF intake — 8821 already signed
  REQUIRES_8821: 69.98,      // CSV intake — needs 8821 signature
  REORDER: 59.98,            // Flat reorder rate
  CLEARFIRM_MONTHLY: 2499.00, // Fixed monthly
  EMPLOYER_API: 39.98,        // Per API call
};

function getEntityRate(intakeMethod: string, productType: string, clientSlug: string): number {
  if (clientSlug === 'clearfirm') return 0; // Fixed monthly, not per-entity
  if (productType === 'employment') return RATES.EMPLOYER_API;
  if (intakeMethod === 'pdf' || intakeMethod === 'manual') return RATES.PRE_SIGNED_8821;
  return RATES.REQUIRES_8821; // csv or api (non-clearfirm)
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatMonth(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
  });
}

interface PageProps {
  searchParams: Promise<{ month?: string }>;
}

export default async function AdminBillingPage({ searchParams }: PageProps) {
  const { month: monthFilter } = await searchParams;
  const supabase = await createServerComponentClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: adminProfile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null; error: any };

  if (!adminProfile || adminProfile.role !== 'admin') redirect('/');

  // Fetch all clients with billing info
  const { data: clients } = await supabase
    .from('clients')
    .select('id, name, slug, free_trial, billing_payment_method, billing_ap_email, billing_rate_pdf, billing_rate_csv, api_key')
    .order('name') as { data: any[] | null; error: any };

  // Fetch all invoices
  const { data: invoices } = await supabase
    .from('invoices')
    .select('*, clients(name, slug)')
    .order('billing_period_start', { ascending: false }) as { data: any[] | null; error: any };

  // Fetch all requests with completed entities for current month revenue calc
  const now = new Date();
  const currentMonth = monthFilter || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [currentYear, currentMo] = currentMonth.split('-').map(Number);
  const periodStart = `${currentYear}-${String(currentMo).padStart(2, '0')}-01`;
  const periodEnd = new Date(currentYear, currentMo, 0).toISOString().split('T')[0];

  const { data: allRequests } = await supabase
    .from('requests')
    .select('id, client_id, intake_method, product_type, request_entities(id, status, completed_at)')
    .order('created_at', { ascending: false }) as { data: any[] | null; error: any };

  // Calculate per-client revenue for the selected month
  const clientRevenueMap: Record<string, {
    name: string;
    slug: string;
    entitiesThisMonth: number;
    revenueThisMonth: number;
    totalEntitiesAllTime: number;
    totalRevenueAllTime: number;
    freeTrialEntities: number;
    isFixedRate: boolean;
    fixedAmount: number;
    billingMethod: string | null;
    outstandingInvoices: number;
    overdueInvoices: number;
  }> = {};

  // Init client map
  (clients || []).forEach((c: any) => {
    clientRevenueMap[c.id] = {
      name: c.name,
      slug: c.slug,
      entitiesThisMonth: 0,
      revenueThisMonth: 0,
      totalEntitiesAllTime: 0,
      totalRevenueAllTime: 0,
      freeTrialEntities: 0,
      isFixedRate: c.slug === 'clearfirm',
      fixedAmount: c.slug === 'clearfirm' ? RATES.CLEARFIRM_MONTHLY : 0,
      billingMethod: c.billing_payment_method,
      outstandingInvoices: 0,
      overdueInvoices: 0,
    };
  });

  // Build free trial entity sets per client (first 3 completed)
  const freeTrialSets: Record<string, Set<string>> = {};
  (clients || []).forEach((c: any) => {
    if (c.free_trial) {
      const clientEntities = (allRequests || [])
        .filter((r: any) => r.client_id === c.id)
        .flatMap((r: any) => (r.request_entities || []).map((e: any) => ({ ...e, intake_method: r.intake_method })))
        .filter((e: any) => e.status === 'completed' && e.completed_at)
        .sort((a: any, b: any) => new Date(a.completed_at).getTime() - new Date(b.completed_at).getTime());
      freeTrialSets[c.id] = new Set(clientEntities.slice(0, 3).map((e: any) => e.id));
    } else {
      freeTrialSets[c.id] = new Set();
    }
  });

  const periodStartDate = new Date(periodStart);
  const periodEndDate = new Date(periodEnd + 'T23:59:59.999Z');

  // Calculate revenue
  (allRequests || []).forEach((req: any) => {
    const clientId = req.client_id;
    if (!clientRevenueMap[clientId]) return;
    const clientData = clientRevenueMap[clientId];
    const isFreeTrialClient = freeTrialSets[clientId] || new Set();

    (req.request_entities || []).forEach((entity: any) => {
      if (entity.status !== 'completed' || !entity.completed_at) return;

      const completedDate = new Date(entity.completed_at);
      const isFree = isFreeTrialClient.has(entity.id);
      const rate = isFree ? 0 : getEntityRate(req.intake_method, req.product_type, clientData.slug);

      // All time
      clientData.totalEntitiesAllTime++;
      clientData.totalRevenueAllTime += rate;
      if (isFree) clientData.freeTrialEntities++;

      // This month
      if (completedDate >= periodStartDate && completedDate <= periodEndDate) {
        clientData.entitiesThisMonth++;
        clientData.revenueThisMonth += rate;
      }
    });

    // Add fixed monthly rate for Clearfirm if they had any activity this month
    // (handled separately below)
  });

  // For fixed-rate clients (Clearfirm), override revenue with fixed monthly
  Object.values(clientRevenueMap).forEach((c) => {
    if (c.isFixedRate && c.entitiesThisMonth > 0) {
      c.revenueThisMonth = c.fixedAmount;
    }
  });

  // Calculate invoice stats
  (invoices || []).forEach((inv: any) => {
    const clientId = inv.client_id;
    if (!clientRevenueMap[clientId]) return;
    if (inv.status === 'sent' || inv.status === 'draft') {
      clientRevenueMap[clientId].outstandingInvoices++;
    }
    if (inv.status === 'overdue') {
      clientRevenueMap[clientId].overdueInvoices++;
    }
  });

  // Aggregate totals
  const totals = {
    mrrThisMonth: Object.values(clientRevenueMap).reduce((sum, c) => sum + c.revenueThisMonth, 0),
    entitiesThisMonth: Object.values(clientRevenueMap).reduce((sum, c) => sum + c.entitiesThisMonth, 0),
    totalRevenueAllTime: Object.values(clientRevenueMap).reduce((sum, c) => sum + c.totalRevenueAllTime, 0),
    totalEntitiesAllTime: Object.values(clientRevenueMap).reduce((sum, c) => sum + c.totalEntitiesAllTime, 0),
  };

  // Add fixed monthly revenue for Clearfirm to all-time total
  const clearfirmClient = Object.values(clientRevenueMap).find(c => c.slug === 'clearfirm');
  if (clearfirmClient) {
    // Estimate all-time by number of months active (use invoice count as proxy)
    const clearfirmInvoices = (invoices || []).filter((inv: any) => {
      const client = (clients || []).find((c: any) => c.id === inv.client_id);
      return client?.slug === 'clearfirm';
    });
    clearfirmClient.totalRevenueAllTime = clearfirmInvoices.length * RATES.CLEARFIRM_MONTHLY + clearfirmClient.revenueThisMonth;
    totals.totalRevenueAllTime = Object.values(clientRevenueMap).reduce((sum, c) => sum + c.totalRevenueAllTime, 0);
  }

  // Invoice status breakdown
  const invoiceStats = {
    draft: (invoices || []).filter((i: any) => i.status === 'draft').length,
    sent: (invoices || []).filter((i: any) => i.status === 'sent').length,
    paid: (invoices || []).filter((i: any) => i.status === 'paid').length,
    overdue: (invoices || []).filter((i: any) => i.status === 'overdue').length,
  };

  const outstandingAR = (invoices || [])
    .filter((i: any) => i.status === 'sent' || i.status === 'overdue')
    .reduce((sum: number, i: any) => sum + (i.total_amount || 0), 0);

  const overdueAR = (invoices || [])
    .filter((i: any) => i.status === 'overdue')
    .reduce((sum: number, i: any) => sum + (i.total_amount || 0), 0);

  // Generate month navigation (last 6 months)
  const months: { label: string; value: string }[] = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      label: d.toLocaleDateString('en-US', { year: 'numeric', month: 'short' }),
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
    });
  }

  const getInvoiceStatusColor = (status: string) => {
    switch (status) {
      case 'draft': return 'bg-gray-100 text-gray-700';
      case 'sent': return 'bg-blue-100 text-blue-700';
      case 'paid': return 'bg-green-100 text-green-700';
      case 'overdue': return 'bg-red-100 text-red-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-mt-dark">Billing Overview</h1>
            <p className="text-gray-600 mt-1">Revenue, invoices, and accounts receivable</p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/admin"
              className="px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              ← Admin Dashboard
            </Link>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* Month Selector */}
        <div className="flex items-center gap-2 mb-8">
          <span className="text-sm font-medium text-gray-500">Period:</span>
          <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
            {months.map((m) => (
              <Link
                key={m.value}
                href={`/admin/billing?month=${m.value}`}
                className={`px-4 py-2 font-medium transition-colors border-l first:border-l-0 border-gray-300 ${
                  currentMonth === m.value
                    ? 'bg-mt-dark text-white'
                    : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                {m.label}
              </Link>
            ))}
          </div>
        </div>

        {/* Revenue Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-10">
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <p className="text-sm font-medium text-gray-500">Revenue This Month</p>
            <p className="text-3xl font-bold text-mt-dark mt-2">{formatCurrency(totals.mrrThisMonth)}</p>
            <p className="text-sm text-gray-400 mt-1">{totals.entitiesThisMonth} entities completed</p>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <p className="text-sm font-medium text-gray-500">Outstanding AR</p>
            <p className="text-3xl font-bold text-yellow-600 mt-2">{formatCurrency(outstandingAR)}</p>
            <p className="text-sm text-gray-400 mt-1">{invoiceStats.sent + invoiceStats.overdue} unpaid invoices</p>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <p className="text-sm font-medium text-gray-500">Overdue</p>
            <p className={`text-3xl font-bold mt-2 ${overdueAR > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {formatCurrency(overdueAR)}
            </p>
            <p className="text-sm text-gray-400 mt-1">{invoiceStats.overdue} overdue invoices</p>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <p className="text-sm font-medium text-gray-500">All-Time Revenue</p>
            <p className="text-3xl font-bold text-mt-dark mt-2">{formatCurrency(totals.totalRevenueAllTime)}</p>
            <p className="text-sm text-gray-400 mt-1">{totals.totalEntitiesAllTime} entities total</p>
          </div>
        </div>

        {/* Pricing Reference */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-10">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">Pricing Schedule</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="text-center p-3 bg-gray-50 rounded-lg">
              <p className="text-lg font-bold text-mt-dark">{formatCurrency(RATES.PRE_SIGNED_8821)}</p>
              <p className="text-xs text-gray-500 mt-1">Pre-signed 8821</p>
              <p className="text-xs text-gray-400">(PDF/manual intake)</p>
            </div>
            <div className="text-center p-3 bg-gray-50 rounded-lg">
              <p className="text-lg font-bold text-mt-dark">{formatCurrency(RATES.REQUIRES_8821)}</p>
              <p className="text-xs text-gray-500 mt-1">Requires 8821 sig</p>
              <p className="text-xs text-gray-400">(CSV intake)</p>
            </div>
            <div className="text-center p-3 bg-gray-50 rounded-lg">
              <p className="text-lg font-bold text-mt-dark">{formatCurrency(RATES.REORDER)}</p>
              <p className="text-xs text-gray-500 mt-1">Reorders</p>
              <p className="text-xs text-gray-400">(flat rate)</p>
            </div>
            <div className="text-center p-3 bg-blue-50 rounded-lg">
              <p className="text-lg font-bold text-blue-700">{formatCurrency(RATES.CLEARFIRM_MONTHLY)}</p>
              <p className="text-xs text-gray-500 mt-1">Clearfirm</p>
              <p className="text-xs text-gray-400">(fixed monthly)</p>
            </div>
            <div className="text-center p-3 bg-indigo-50 rounded-lg">
              <p className="text-lg font-bold text-indigo-700">{formatCurrency(RATES.EMPLOYER_API)}</p>
              <p className="text-xs text-gray-500 mt-1">Employer.com</p>
              <p className="text-xs text-gray-400">(per API call)</p>
            </div>
          </div>
        </div>

        {/* Per-Client Revenue Table */}
        <div className="mb-10">
          <h2 className="text-xl font-bold text-mt-dark mb-4">Revenue by Client — {months.find(m => m.value === currentMonth)?.label || currentMonth}</h2>
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Client</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-gray-700">Entities</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-gray-700">Revenue</th>
                  <th className="px-6 py-3 text-center text-sm font-semibold text-gray-700">Billing Type</th>
                  <th className="px-6 py-3 text-center text-sm font-semibold text-gray-700">Payment</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-gray-700">Outstanding</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-gray-700">All-Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {Object.entries(clientRevenueMap)
                  .sort(([, a], [, b]) => b.revenueThisMonth - a.revenueThisMonth)
                  .map(([clientId, data]) => (
                  <tr key={clientId} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4">
                      <div>
                        <span className="font-semibold text-mt-dark">{data.name}</span>
                        {data.freeTrialEntities > 0 && (
                          <span className="ml-2 text-xs px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full">
                            {data.freeTrialEntities} free trial
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span className="text-sm font-medium text-gray-700">{data.entitiesThisMonth}</span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span className="text-sm font-bold text-mt-dark">
                        {data.isFixedRate && data.entitiesThisMonth > 0
                          ? formatCurrency(data.fixedAmount)
                          : formatCurrency(data.revenueThisMonth)}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${
                        data.isFixedRate ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-700'
                      }`}>
                        {data.isFixedRate ? 'Fixed Monthly' : 'Per Entity'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-center">
                      {data.billingMethod ? (
                        <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-green-100 text-green-700">
                          {data.billingMethod.toUpperCase()}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">Not set</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right">
                      {data.outstandingInvoices > 0 ? (
                        <span className="text-sm font-medium text-yellow-600">
                          {data.outstandingInvoices} invoice{data.outstandingInvoices > 1 ? 's' : ''}
                          {data.overdueInvoices > 0 && (
                            <span className="text-red-600 ml-1">({data.overdueInvoices} overdue)</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span className="text-sm text-gray-500">{formatCurrency(data.totalRevenueAllTime)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 border-t-2 border-gray-300">
                <tr>
                  <td className="px-6 py-3 font-bold text-mt-dark">Total</td>
                  <td className="px-6 py-3 text-right font-bold text-mt-dark">{totals.entitiesThisMonth}</td>
                  <td className="px-6 py-3 text-right font-bold text-mt-dark">{formatCurrency(totals.mrrThisMonth)}</td>
                  <td className="px-6 py-3"></td>
                  <td className="px-6 py-3"></td>
                  <td className="px-6 py-3"></td>
                  <td className="px-6 py-3 text-right font-bold text-gray-500">{formatCurrency(totals.totalRevenueAllTime)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        {/* Invoice Status Breakdown */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-10">
          {/* Invoice Counts by Status */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <h3 className="text-lg font-bold text-mt-dark mb-4">Invoices by Status</h3>
            <div className="space-y-3">
              {[
                { label: 'Draft', count: invoiceStats.draft, color: 'bg-gray-200', textColor: 'text-gray-700' },
                { label: 'Sent', count: invoiceStats.sent, color: 'bg-blue-200', textColor: 'text-blue-700' },
                { label: 'Paid', count: invoiceStats.paid, color: 'bg-green-200', textColor: 'text-green-700' },
                { label: 'Overdue', count: invoiceStats.overdue, color: 'bg-red-200', textColor: 'text-red-700' },
              ].map((item) => {
                const total = invoiceStats.draft + invoiceStats.sent + invoiceStats.paid + invoiceStats.overdue;
                const pct = total > 0 ? Math.round((item.count / total) * 100) : 0;
                return (
                  <div key={item.label} className="flex items-center gap-3">
                    <span className={`w-20 text-sm font-medium ${item.textColor}`}>{item.label}</span>
                    <div className="flex-1 bg-gray-100 rounded-full h-3">
                      <div className={`${item.color} h-3 rounded-full`} style={{ width: `${pct}%` }}></div>
                    </div>
                    <span className="w-8 text-right text-sm font-bold text-gray-700">{item.count}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* AR Summary */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <h3 className="text-lg font-bold text-mt-dark mb-4">Accounts Receivable</h3>
            <div className="space-y-4">
              <div className="flex justify-between items-center p-3 bg-yellow-50 rounded-lg">
                <span className="text-sm font-medium text-yellow-800">Outstanding (Sent)</span>
                <span className="text-lg font-bold text-yellow-700">
                  {formatCurrency(
                    (invoices || [])
                      .filter((i: any) => i.status === 'sent')
                      .reduce((sum: number, i: any) => sum + (i.total_amount || 0), 0)
                  )}
                </span>
              </div>
              <div className="flex justify-between items-center p-3 bg-red-50 rounded-lg">
                <span className="text-sm font-medium text-red-800">Overdue</span>
                <span className="text-lg font-bold text-red-700">{formatCurrency(overdueAR)}</span>
              </div>
              <div className="flex justify-between items-center p-3 bg-green-50 rounded-lg">
                <span className="text-sm font-medium text-green-800">Collected (Paid)</span>
                <span className="text-lg font-bold text-green-700">
                  {formatCurrency(
                    (invoices || [])
                      .filter((i: any) => i.status === 'paid')
                      .reduce((sum: number, i: any) => sum + (i.total_amount || 0), 0)
                  )}
                </span>
              </div>
              <div className="flex justify-between items-center p-3 bg-gray-50 rounded-lg border-t-2 border-gray-200">
                <span className="text-sm font-bold text-gray-800">Total Invoiced</span>
                <span className="text-lg font-bold text-mt-dark">
                  {formatCurrency(
                    (invoices || []).reduce((sum: number, i: any) => sum + (i.total_amount || 0), 0)
                  )}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Recent Invoices Table */}
        <div>
          <h2 className="text-xl font-bold text-mt-dark mb-4">Recent Invoices</h2>
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            {(invoices || []).length > 0 ? (
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Invoice #</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Client</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Period</th>
                    <th className="px-6 py-3 text-right text-sm font-semibold text-gray-700">Entities</th>
                    <th className="px-6 py-3 text-right text-sm font-semibold text-gray-700">Amount</th>
                    <th className="px-6 py-3 text-center text-sm font-semibold text-gray-700">Status</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Due Date</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Payment</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {(invoices || []).slice(0, 20).map((inv: any) => (
                    <tr key={inv.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-4">
                        <code className="text-sm font-mono text-mt-dark">{inv.invoice_number}</code>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-700">{inv.clients?.name || 'Unknown'}</td>
                      <td className="px-6 py-4 text-sm text-gray-600">{formatMonth(inv.billing_period_start)}</td>
                      <td className="px-6 py-4 text-right text-sm text-gray-700">{inv.total_entities}</td>
                      <td className="px-6 py-4 text-right text-sm font-bold text-mt-dark">{formatCurrency(inv.total_amount)}</td>
                      <td className="px-6 py-4 text-center">
                        <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${getInvoiceStatusColor(inv.status)}`}>
                          {inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600">
                        {inv.due_date ? formatDate(inv.due_date) : '—'}
                      </td>
                      <td className="px-6 py-4">
                        {inv.payment_method ? (
                          <span className="text-xs font-semibold text-gray-600">{inv.payment_method.toUpperCase()}</span>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                        {inv.mercury_reference && (
                          <p className="text-xs text-gray-400 mt-0.5">Ref: {inv.mercury_reference}</p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="px-6 py-12 text-center">
                <p className="text-gray-500 font-medium">No invoices generated yet</p>
                <p className="text-sm text-gray-400 mt-1">Invoices are auto-generated on the 1st of each month</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
