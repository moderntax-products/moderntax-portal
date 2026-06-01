import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import Link from 'next/link';
import { getClassificationLabel, getClassificationColor } from '@/lib/mask';
import { BillingSettingsForm } from '@/components/BillingSettingsForm';
import { PayNowButton } from '@/components/PayNowButton';
import { InvoiceBreakdownTable } from '@/components/InvoiceBreakdownTable';

// Free trial: each new client gets 3 free entities — surfaced as
// "$239.94 trial credit" so managers see the dollar value of what
// their team already has on tap. $79.98 per-entity is the per-TIN
// reference rate (matches Cal Statewide MSA), used only for display.
const TRIAL_ENTITIES_PER_CLIENT = 3;
const TRIAL_DISPLAY_RATE_PER_ENTITY = 79.98;

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

  // Manager-only page (scoped to client_id). Admins land on /admin which
  // has the cross-client view; processors don't see billing at all.
  if (!profile) redirect('/');
  if (profile.role === 'admin') redirect('/admin');
  if (profile.role !== 'manager' || !profile.client_id) {
    redirect('/');
  }

  // Get client with billing settings + Mercury enrollment + address fields
  // + subscription billing fields (for clients on a flat-monthly model
  // like Clearfirm at $2,499/mo + overage; default model is per_tin).
  const { data: client } = await supabase
    .from('clients')
    .select('id, name, slug, free_trial, intake_methods, billing_payment_method, billing_ap_email, billing_ap_phone, billing_rate_pdf, billing_rate_csv, address_line1, address_line2, address_city, address_state, address_postal_code, mercury_customer_id, billing_model, subscription_monthly_amount, subscription_included_entities, subscription_overage_rate, billing_effective_from')
    .eq('id', profile.client_id)
    .single() as { data: any | null; error: any };

  if (!client) redirect('/');

  const ratePdf = client.billing_rate_pdf || 59.98;
  const rateCsv = client.billing_rate_csv || 69.98;
  const isSubscription = client.billing_model === 'subscription';
  const subMonthly = Number(client.subscription_monthly_amount) || 0;
  const subIncluded = Number(client.subscription_included_entities) || 0;
  const subOverageRate = Number(client.subscription_overage_rate) || 0;

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

  // Calculate totals for selected month.
  // - Per-TIN model: sum each entity's rate (free-trial entities excluded).
  // - Subscription model: flat monthly + overage above included cap.
  const billableEntities = monthEntities.filter((e) => !freeEntityIds.has(e.id));
  const freeEntities = monthEntities.filter((e) => freeEntityIds.has(e.id));

  let monthTotal: number;
  let monthOverageEntities = 0;
  let monthOverageAmount = 0;
  if (isSubscription) {
    // Subscription clients pay the flat fee any month they're active.
    // Overage = entities above subscription_included cap, billed at overage rate.
    monthOverageEntities = Math.max(0, monthEntities.length - subIncluded);
    monthOverageAmount = monthOverageEntities * subOverageRate;
    monthTotal = subMonthly + monthOverageAmount;
  } else {
    monthTotal = billableEntities.reduce((sum, e) => sum + e.rate, 0);
  }

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

  // Get invoices for this client (includes Mercury pay URLs + PDF URLs once
  // the auto-invoice cron has fired and the daily mercury-reconcile sync ran)
  const { data: invoices } = await supabase
    .from('invoices')
    .select('*')
    .eq('client_id', profile.client_id)
    .order('billing_period_start', { ascending: false }) as { data: any[] | null; error: any };

  // ===== "This month so far" — real-time billing projection =====
  // Computed live from completed entities (NOT the invoice row, which only
  // exists after the 1st-of-month auto-invoice cron). Lets the manager see
  // exactly what their next Mercury invoice will look like before it fires.
  const now = new Date();
  const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const thisMonthEntities = allCompletedEntities.filter(e => e.month === thisMonthKey);
  const thisMonthBillable = thisMonthEntities.filter(e => !freeEntityIds.has(e.id));
  const thisMonthFreeCount = thisMonthEntities.length - thisMonthBillable.length;

  let thisMonthTotal: number;
  let thisMonthOverageEntities = 0;
  let projectedTotal: number;
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  if (isSubscription) {
    // Subscription: live total = flat fee + accrued overage so far.
    // Projection extrapolates today's overage entity count to month-end.
    thisMonthOverageEntities = Math.max(0, thisMonthEntities.length - subIncluded);
    thisMonthTotal = subMonthly + thisMonthOverageEntities * subOverageRate;
    const projectedEntities = dayOfMonth > 0
      ? Math.round((thisMonthEntities.length / dayOfMonth) * daysInMonth)
      : thisMonthEntities.length;
    const projectedOverage = Math.max(0, projectedEntities - subIncluded);
    projectedTotal = subMonthly + projectedOverage * subOverageRate;
  } else {
    thisMonthTotal = thisMonthBillable.reduce((sum, e) => sum + e.rate, 0);
    projectedTotal = dayOfMonth > 0
      ? Math.round((thisMonthTotal / dayOfMonth) * daysInMonth * 100) / 100
      : thisMonthTotal;
  }

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
  const mercuryEnrolled = !!client.mercury_customer_id;

  // Free trial credit display for the top-of-page banner
  const totalCompletedAcrossAllTime = allCompletedEntities.length;
  const trialUsed = Math.min(TRIAL_ENTITIES_PER_CLIENT, totalCompletedAcrossAllTime);
  const trialRemaining = Math.max(0, TRIAL_ENTITIES_PER_CLIENT - trialUsed);
  const trialRemainingValue = trialRemaining * TRIAL_DISPLAY_RATE_PER_ENTITY;

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
        {/* FREE TRIAL CREDITS — top-of-page so managers see the dollar
            value of what their team already has on tap. Hidden once the
            trial is exhausted. */}
        {client.free_trial && trialRemaining > 0 && (
          <div className="bg-gradient-to-br from-emerald-50 to-emerald-100/40 rounded-xl border border-emerald-300 p-5 mb-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="flex items-start gap-4">
                <div className="shrink-0 w-12 h-12 rounded-lg bg-white shadow-sm flex items-center justify-center">
                  <span className="text-2xl">🎁</span>
                </div>
                <div>
                  <div className="flex flex-wrap items-baseline gap-2 mb-1">
                    <h3 className="text-lg font-bold text-emerald-900">Free trial credit</h3>
                    <span className="text-xs font-semibold text-emerald-700 bg-emerald-200/60 px-2 py-0.5 rounded-full">
                      {trialUsed} of {TRIAL_ENTITIES_PER_CLIENT} used
                    </span>
                  </div>
                  <p className="text-sm text-emerald-900">
                    <span className="font-bold text-2xl">${trialRemainingValue.toFixed(2)}</span>
                    <span className="ml-1.5 text-emerald-800">remaining</span>
                    <span className="ml-2 text-xs text-emerald-700">· {trialRemaining} free request{trialRemaining === 1 ? '' : 's'} for your entire team (processors + managers)</span>
                  </p>
                </div>
              </div>
              <Link href="/new" className="shrink-0 inline-flex items-center gap-2 px-4 py-2 bg-mt-green text-white text-sm font-bold rounded-lg hover:bg-mt-green/90">
                Use credit →
              </Link>
            </div>
            <div className="mt-4 h-2 bg-white/60 rounded-full overflow-hidden border border-emerald-200">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${(trialUsed / TRIAL_ENTITIES_PER_CLIENT) * 100}%` }} />
            </div>
          </div>
        )}

        {/* Billing Settings Card */}
        <div className="bg-white rounded-lg shadow mb-8">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-mt-dark">Payment Settings</h2>
            {mercuryEnrolled ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                Mercury Auto-Pay Enrolled
              </span>
            ) : billingSetup ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
                Saved — enroll to enable Pay Now
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-700">
                Setup Required
              </span>
            )}
          </div>
          <div className="p-6">
            <BillingSettingsForm
              initialPaymentMethod={client.billing_payment_method || ''}
              initialApEmail={client.billing_ap_email || ''}
              initialApPhone={client.billing_ap_phone || ''}
              initialAddressLine1={client.address_line1 || ''}
              initialAddressLine2={client.address_line2 || ''}
              initialAddressCity={client.address_city || ''}
              initialAddressState={client.address_state || ''}
              initialAddressPostalCode={client.address_postal_code || ''}
              mercuryCustomerId={client.mercury_customer_id || null}
            />
          </div>
        </div>

        {/* Subscription billing summary — only for clients on a flat
            monthly model (Clearfirm, future resellers). Makes the
            pricing model unambiguous so a manager doesn't try to
            reverse-engineer the total from per-entity rates. */}
        {isSubscription && (
          <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-5 mb-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-bold uppercase tracking-wide text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full">Subscription Plan</span>
                  <h3 className="text-base font-bold text-mt-dark">Flat Monthly Billing</h3>
                </div>
                <p className="text-sm text-gray-700">
                  <span className="font-bold text-2xl text-blue-700">${subMonthly.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  <span className="text-gray-600 ml-1">/ month</span>
                  <span className="text-gray-500 mx-2">·</span>
                  <span>{subIncluded.toLocaleString()} entities included</span>
                  <span className="text-gray-500 mx-2">·</span>
                  <span>${subOverageRate.toFixed(2)} per overage entity</span>
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-500 uppercase">Usage this month</p>
                <p className="text-2xl font-bold text-mt-dark">
                  {thisMonthEntities.length}<span className="text-base text-gray-500"> / {subIncluded}</span>
                </p>
                {thisMonthOverageEntities > 0 ? (
                  <p className="text-xs text-amber-700 font-semibold">+{thisMonthOverageEntities} overage</p>
                ) : (
                  <p className="text-xs text-emerald-700 font-semibold">{subIncluded - thisMonthEntities.length} remaining in plan</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Live "This Month" Projection — refreshes every page load (server component).
            Mercury auto-invoice fires on the 1st of each month at 06:00 UTC; this
            panel shows what that invoice will look like BEFORE it fires. Replaces
            the old "wait until invoice arrives to know what you owe" experience. */}
        <div className="bg-gradient-to-br from-emerald-50 to-emerald-100/40 border border-emerald-200 rounded-lg p-5 mb-6">
          <div className="flex flex-wrap items-start justify-between mb-3 gap-4">
            <div>
              <h2 className="text-lg font-bold text-mt-dark">This Month So Far</h2>
              <p className="text-xs text-gray-600">
                {formatMonth(thisMonthKey)} · day {dayOfMonth} of {daysInMonth} · live count
              </p>
              <p className="text-xs text-gray-500 uppercase tracking-wide mt-3">Projected month-end</p>
              <p className="text-2xl font-bold text-emerald-700">
                ${projectedTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </div>
            <PayNowButton
              billableThisMonth={thisMonthBillable.length}
              amountThisMonth={thisMonthTotal}
              mercuryEnrolled={mercuryEnrolled}
            />
          </div>
          <div className="grid grid-cols-3 gap-3 text-sm">
            <div className="bg-white rounded p-3">
              <p className="text-xs text-gray-500 uppercase">Completed</p>
              <p className="text-lg font-bold text-mt-dark mt-1">{thisMonthEntities.length}</p>
              {isSubscription ? (
                <p className="text-xs text-gray-500">
                  {Math.min(thisMonthEntities.length, subIncluded)} of {subIncluded} included{thisMonthOverageEntities > 0 ? ` · ${thisMonthOverageEntities} overage` : ''}
                </p>
              ) : (
                <p className="text-xs text-gray-500">{thisMonthBillable.length} billable, {thisMonthFreeCount} free-trial</p>
              )}
            </div>
            <div className="bg-white rounded p-3">
              <p className="text-xs text-gray-500 uppercase">{isSubscription ? 'Subscription + overage' : 'Billed so far'}</p>
              <p className="text-lg font-bold text-mt-dark mt-1">
                ${thisMonthTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
              {isSubscription ? (
                <p className="text-xs text-gray-500">
                  ${subMonthly.toFixed(2)}/mo flat
                  {thisMonthOverageEntities > 0 && ` + ${thisMonthOverageEntities} × $${subOverageRate.toFixed(2)}`}
                </p>
              ) : (
                <p className="text-xs text-gray-500">at ${ratePdf.toFixed(2)}/PDF · ${rateCsv.toFixed(2)}/CSV</p>
              )}
            </div>
            <div className="bg-white rounded p-3">
              <p className="text-xs text-gray-500 uppercase">Next invoice fires</p>
              <p className="text-lg font-bold text-mt-dark mt-1">
                {(() => {
                  const nextInvoiceDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
                  return nextInvoiceDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                })()}
              </p>
              <p className="text-xs text-gray-500">via Mercury · ACH</p>
            </div>
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
                    <p className="text-gray-600 text-sm font-medium">{isSubscription ? 'Plan Usage' : 'Billable'}</p>
                    {isSubscription ? (
                      <>
                        <p className="text-3xl font-bold text-mt-dark mt-2">
                          {Math.min(monthEntities.length, subIncluded)}<span className="text-base text-gray-500"> / {subIncluded}</span>
                        </p>
                        {monthOverageEntities > 0 && (
                          <p className="text-xs text-amber-700 mt-1 font-semibold">+{monthOverageEntities} overage @ ${subOverageRate.toFixed(2)}</p>
                        )}
                      </>
                    ) : (
                      <>
                        <p className="text-3xl font-bold text-mt-dark mt-2">{billableEntities.length}</p>
                        {freeEntities.length > 0 && (
                          <p className="text-xs text-green-600 mt-1">{freeEntities.length} free (trial)</p>
                        )}
                      </>
                    )}
                  </div>
                  <div className="bg-white rounded-lg shadow p-6">
                    <p className="text-gray-600 text-sm font-medium">Total Amount</p>
                    <p className="text-3xl font-bold text-mt-dark mt-2">
                      ${monthTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                    {isSubscription && (
                      <p className="text-xs text-gray-500 mt-1">
                        ${subMonthly.toFixed(2)} subscription{monthOverageAmount > 0 ? ` + $${monthOverageAmount.toFixed(2)} overage` : ''}
                      </p>
                    )}
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

                {/* Breakdown by Processor — under subscription, the
                    per-processor dollar attribution is meaningless
                    (everyone pulls from the same flat plan), so we hide
                    the Amount column and surface a "share of plan" % instead. */}
                {Object.keys(byProcessor).length > 0 && (
                  <div className="bg-white rounded-lg shadow overflow-hidden mb-8">
                    <div className="px-6 py-4 border-b border-gray-200">
                      <h2 className="text-lg font-semibold text-mt-dark">By Processor</h2>
                      {isSubscription && (
                        <p className="text-xs text-gray-500 mt-0.5">Volume only — subscription pricing is flat across the team.</p>
                      )}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead className="bg-gray-50 border-b border-gray-200">
                          <tr>
                            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Processor</th>
                            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Entities</th>
                            {!isSubscription && (
                              <th className="px-6 py-3 text-right text-sm font-semibold text-gray-700">Amount</th>
                            )}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                          {Object.values(byProcessor)
                            .sort((a, b) => b.entities.length - a.entities.length)
                            .map((proc) => (
                              <tr key={proc.name} className="hover:bg-gray-50">
                                <td className="px-6 py-4 text-sm font-semibold text-mt-dark">{proc.name}</td>
                                <td className="px-6 py-4 text-sm text-gray-600">{proc.entities.length}</td>
                                {!isSubscription && (
                                  <td className="px-6 py-4 text-sm font-semibold text-gray-900 text-right">
                                    ${proc.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                )}
                              </tr>
                            ))}
                          <tr className="bg-gray-50 font-semibold">
                            <td className="px-6 py-3 text-sm text-mt-dark">TOTAL</td>
                            <td className="px-6 py-3 text-sm text-gray-900">{monthEntities.length}</td>
                            {!isSubscription && (
                              <td className="px-6 py-3 text-sm text-gray-900 text-right">
                                ${monthTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                            )}
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
                            {!isSubscription && (
                              <th className="px-6 py-3 text-right text-sm font-semibold text-gray-700">Amount</th>
                            )}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                          {Object.values(byLoan)
                            .sort((a, b) => b.entities.length - a.entities.length)
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
                                  {!isSubscription && (
                                    <td className="px-6 py-3 text-sm text-right">
                                      {freeEntityIds.has(entity.id) ? (
                                        <span className="text-green-600 font-medium">Free</span>
                                      ) : (
                                        <span className="font-semibold text-gray-900">
                                          ${entity.rate.toFixed(2)}
                                        </span>
                                      )}
                                    </td>
                                  )}
                                </tr>
                              ))
                            )}
                          <tr className="bg-gray-50 font-semibold">
                            <td className="px-6 py-3 text-sm text-mt-dark" colSpan={6}>TOTAL</td>
                            {!isSubscription && (
                              <td className="px-6 py-3 text-sm text-gray-900 text-right">
                                ${monthTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                            )}
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
                            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                          {(invoices || []).flatMap((inv: any) => [
                            <tr key={inv.id} className="hover:bg-gray-50">
                              <td className="px-6 py-4 text-sm font-mono text-mt-dark">{inv.invoice_number}</td>
                              <td className="px-6 py-4 text-sm text-gray-600">
                                {formatMonth(inv.billing_period_start.slice(0, 7))}
                              </td>
                              <td className="px-6 py-4 text-sm text-gray-600">
                                {inv.total_entities}
                                {inv.monitoring_entities > 0 && (
                                  <span className="block text-xs text-gray-400">+{inv.monitoring_entities} monitoring</span>
                                )}
                              </td>
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
                              <td className="px-6 py-4">
                                <div className="flex gap-2">
                                  {inv.mercury_pay_url && inv.status !== 'paid' && (
                                    <a
                                      href={inv.mercury_pay_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="px-2.5 py-1 text-xs font-semibold rounded bg-mt-green text-white hover:bg-mt-green/90"
                                    >
                                      Pay →
                                    </a>
                                  )}
                                  {inv.mercury_pdf_url && (
                                    <a
                                      href={inv.mercury_pdf_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="px-2.5 py-1 text-xs font-medium rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
                                    >
                                      Invoice PDF
                                    </a>
                                  )}
                                  {/* Itemized breakdown PDF — generated on-demand
                                      (who ordered what, by loan officer). */}
                                  <a
                                    href={`/api/invoicing/breakdown-pdf?invoiceId=${inv.id}`}
                                    className="px-2.5 py-1 text-xs font-medium rounded border border-indigo-300 text-indigo-700 hover:bg-indigo-50"
                                  >
                                    Breakdown PDF
                                  </a>
                                  {!inv.mercury_pay_url && !inv.mercury_pdf_url && (
                                    <span className="text-xs text-gray-400 italic">—</span>
                                  )}
                                </div>
                              </td>
                            </tr>,
                            // Itemized breakdown — collapsible, only rendered
                            // when the invoice has the new JSONB breakdown
                            // populated. Spans all 8 columns of the parent row.
                            inv.breakdown ? (
                              <tr key={`${inv.id}-breakdown`}>
                                <td colSpan={8} className="p-0">
                                  <InvoiceBreakdownTable breakdown={inv.breakdown} />
                                </td>
                              </tr>
                            ) : null,
                          ].filter(Boolean))}
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
