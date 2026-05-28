/**
 * /payment-method
 *
 * Where managers attach a card or US bank account to their ModernTax client
 * after using up the 3 free trial pulls. The saved method auto-charges
 * monthly invoices, add-on purchases, and tier upgrades.
 *
 * Server component shell:
 *   - Auth gate (manager/admin only)
 *   - Reads existing payment-method state from clients to render either:
 *       a) "Method already on file: Visa ending in 4242" + replace button
 *       b) "No method on file — add one to keep ordering" + Stripe Elements form
 *
 * The Stripe Elements form lives in <PaymentMethodForm/> client component.
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createServerComponentClient } from '@/lib/supabase-server';
import { PaymentMethodForm } from '@/components/PaymentMethodForm';
import { PaymentMethodSuccessRefresh } from '@/components/PaymentMethodSuccessRefresh';
import { formatPaymentMethodLabel } from '@/lib/stripe';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ clientId?: string; status?: string; session_id?: string }>;
}

export default async function PaymentMethodPage({ searchParams }: PageProps) {
  const { clientId: clientIdParam, status: returnStatus, session_id: _returnSessionId } = await searchParams;
  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, client_id, full_name')
    .eq('id', user.id)
    .single() as { data: { role: string; client_id: string | null; full_name: string | null } | null };

  if (!profile) redirect('/login');
  if (!['admin', 'manager'].includes(profile.role)) {
    redirect('/');
  }
  if (!profile.client_id && profile.role !== 'admin') {
    redirect('/');
  }

  // Effective client_id resolution:
  //   - Manager: always their own profile.client_id
  //   - Admin: ?clientId=<uuid> URL param wins; else profile.client_id; else null
  //     (which surfaces a client picker)
  const isAdmin = profile.role === 'admin';
  const effectiveClientId = isAdmin
    ? (clientIdParam || profile.client_id)
    : profile.client_id;

  // Admin support: when admin doesn't have a client picked, fetch the list so
  // we can render a "pick which client to attach a card for" dropdown.
  let allClients: { id: string; name: string }[] = [];
  if (isAdmin && !effectiveClientId) {
    const { data } = await supabase
      .from('clients')
      .select('id, name')
      .order('name', { ascending: true }) as { data: { id: string; name: string }[] | null };
    allClients = data || [];
  }

  // Pull current payment-method state to render the right view (existing vs none).
  const { data: client } = effectiveClientId
    ? (await supabase
        .from('clients')
        .select('id, name, payment_method_type, payment_method_brand, payment_method_last4, payment_method_attached_at, payment_method_status, stripe_payment_method_id, free_trial')
        .eq('id', effectiveClientId)
        .single()) as { data: any }
    : { data: null };

  const hasMethod = !!client?.stripe_payment_method_id && client?.payment_method_status === 'active';
  const label = client ? formatPaymentMethodLabel(client) : 'No payment method on file';

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between">
          <Link href="/" className="text-xl font-bold text-mt-dark">ModernTax</Link>
          <Link href="/" className="text-sm font-semibold text-mt-green hover:underline">
            ← Back to dashboard
          </Link>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <h1 className="text-3xl font-bold text-mt-dark">Payment Method</h1>
        <p className="text-gray-600 mt-2">
          {hasMethod
            ? `${client.name} — saved card auto-charges in-app purchases, monitoring upsells, and tier upgrades. Monthly usage invoices are billed via Mercury (ACH).`
            : `Add a card to ${client?.name || 'your team'} so we can auto-charge add-ons + upgrades. Monthly usage invoices use Mercury ACH separately.`}
        </p>

        {/* Return-from-Stripe-Checkout banners. Stripe redirects back here with
            ?status=success after the user saves a card, or ?status=cancel if
            they backed out. The actual save happens server-side via the
            checkout.session.completed webhook — these are just UX. */}
        {returnStatus === 'success' && (
          <div className="mt-4 rounded-lg p-4 bg-emerald-50 border border-emerald-300">
            <p className="text-sm font-semibold text-emerald-900 flex items-center gap-2">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/>
              </svg>
              Card saved successfully
            </p>
            <p className="text-xs text-emerald-800 mt-1">
              {hasMethod
                ? 'Your saved card is shown below. You can place new orders + buy add-ons immediately.'
                : 'Your card is being saved. This page will refresh automatically once Stripe finishes processing (usually within 5 seconds).'}
            </p>
            {/* Auto-refresh waiter — bridges the gap between Stripe redirect and webhook landing */}
            <PaymentMethodSuccessRefresh hasMethod={hasMethod} />
          </div>
        )}
        {returnStatus === 'cancel' && (
          <div className="mt-4 rounded-lg p-4 bg-amber-50 border border-amber-300">
            <p className="text-sm font-semibold text-amber-900 flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              Card setup canceled
            </p>
            <p className="text-xs text-amber-800 mt-1">
              You backed out of Stripe Checkout before saving. Click &ldquo;Add card via Stripe&rdquo; below to try again.
            </p>
          </div>
        )}

        {/* Admin-only client picker — shows when admin has no client selected.
            Sets the URL ?clientId=… so the page reloads scoped to that client. */}
        {isAdmin && !effectiveClientId && allClients.length > 0 && (
          <div className="mt-6 bg-blue-50 border-2 border-blue-200 rounded-xl p-5">
            <p className="text-sm font-bold text-blue-900 mb-1">
              Admin testing — select a client to attach a payment method for:
            </p>
            <p className="text-xs text-blue-800 mb-3">
              Your admin profile has no client_id, so this page needs an explicit lender to operate against.
            </p>
            <form method="GET" className="flex gap-2 flex-wrap">
              <select
                name="clientId"
                defaultValue=""
                className="flex-1 min-w-[220px] px-3 py-2 text-sm border border-blue-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="" disabled>Pick a lender…</option>
                {allClients.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <button
                type="submit"
                className="px-4 py-2 text-sm font-semibold bg-mt-dark text-white rounded-lg hover:bg-gray-800"
              >
                Continue →
              </button>
            </form>
          </div>
        )}

        {/* Admin: show which client we're operating on so it's never ambiguous */}
        {isAdmin && effectiveClientId && client && (
          <div className="mt-3 inline-flex items-center gap-2 px-2.5 py-1 rounded text-xs font-semibold bg-blue-100 text-blue-900 border border-blue-200">
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path d="M10 2a3 3 0 00-3 3v1H6a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2V8a2 2 0 00-2-2h-1V5a3 3 0 00-3-3z"/></svg>
            Admin · operating as {client.name}
            <Link href="/payment-method" className="ml-2 text-blue-700 hover:underline">switch →</Link>
          </div>
        )}

        {/* Current method on file */}
        {hasMethod && (
          <div className="mt-6 bg-white rounded-xl border-2 border-emerald-300 p-6">
            <div className="flex items-start justify-between flex-wrap gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-emerald-100">
                    <svg className="w-5 h-5 text-emerald-700" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/>
                    </svg>
                  </span>
                  <div>
                    <p className="font-semibold text-mt-dark">{label}</p>
                    <p className="text-xs text-gray-500">
                      On file since {client.payment_method_attached_at ? new Date(client.payment_method_attached_at).toLocaleDateString('en-US', { dateStyle: 'medium' }) : 'recently'}
                    </p>
                  </div>
                </div>
              </div>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-100 text-emerald-800">
                ACTIVE · AUTO-CHARGE ENABLED
              </span>
            </div>
            <div className="mt-4 pt-4 border-t border-gray-100">
              <p className="text-xs text-gray-500">
                Replacing the saved method requires re-entering card or bank details below. We never store the full number — Stripe holds it.
              </p>
            </div>
          </div>
        )}

        {/* Trial state warning if no method + free trial exhausted */}
        {!hasMethod && client && client.free_trial === false && (
          <div className="mt-6 bg-amber-50 border-2 border-amber-300 rounded-xl p-4">
            <p className="text-sm font-semibold text-amber-900 flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              Trial complete — payment method required
            </p>
            <p className="text-xs text-amber-800 mt-1.5">
              Your team has used all 3 free trial pulls. Add a payment method now to keep placing orders. Charges happen at completion at your tier&rsquo;s per-pull rate.
            </p>
          </div>
        )}

        {/* The form itself — only renders when we have an effective client to bill against. */}
        {effectiveClientId && (
          <div className="mt-6 bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="font-bold text-mt-dark mb-1">{hasMethod ? 'Replace payment method' : 'Add a payment method'}</h2>
            <p className="text-xs text-gray-500 mb-4">
              Card{process.env.STRIPE_ENABLE_ACH === 'true' ? ' or US bank account (ACH)' : ''}. Authorized once — auto-charged for all future orders.
            </p>
            <PaymentMethodForm hasExisting={hasMethod} clientId={isAdmin ? effectiveClientId : undefined} />
          </div>
        )}

        <div className="mt-8 text-xs text-gray-500 space-y-2 leading-relaxed">
          <p><strong>What gets charged:</strong> Per-pull rate ($79.98 PAYG / $59.98 Deposit / $39.99 Platform) at each entity completion · monthly invoice rollup · add-on purchases (cash-flow pack $49.99, monitoring $19.99/mo, entity transcript $19.99) · tier upgrade fees.</p>
          <p><strong>Security:</strong> Card details go directly to Stripe — ModernTax never sees the full number. We only store a tokenized reference + the last 4 digits for receipts.</p>
          <p><strong>Refunds:</strong> Per-entity refunds are issued automatically to the same card/bank within 5 business days. ACH micro-deposit verification may be required on first use.</p>
        </div>
      </div>
    </div>
  );
}
