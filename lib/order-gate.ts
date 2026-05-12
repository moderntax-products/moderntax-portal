/**
 * Order gate — central rule for "can this client place a new order?"
 *
 * Rules (any one of these is sufficient — they're OR'd together):
 *   1. Free trial: client has used <3 completed entities lifetime.
 *   2. Stripe payment method on file: clients.stripe_payment_method_id +
 *      payment_method_status='active' (used for in-app card purchases).
 *   3. Recent paid invoice: at least one paid invoice in the last 90 days.
 *   4. ESTABLISHED-CUSTOMER carve-out: free_trial=false AND mercury_customer_id
 *      is set. This grandfathers Mercury ACH customers like Cal Statewide who
 *      have been onboarded as paying accounts but haven't yet generated a
 *      paid invoice (e.g., new month, billing in flight). Without this,
 *      brand-new ACH customers get blocked the day after their trial ends.
 *
 * Customers with overdue invoices stay allowed by rule 4 — they're real
 * accounts, just behind on payment. Surface AR aging in the admin dashboard
 * for collection follow-up; don't block ordering.
 *
 * Used by:
 *   - app/api/upload/csv/route.ts  (intake)
 *   - app/api/upload/pdf/route.ts  (intake)
 *   - app/api/admin/email-intake/route.ts (intake)
 *   - app/page.tsx + dashboard banners (UI surfaces)
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const TRIAL_FREE_ENTITIES = 3;

export interface OrderGateResult {
  allowed: boolean;
  /** Why the order is blocked. Always set when allowed=false. */
  reason?: 'trial_exhausted_no_payment_method_no_recent_paid_invoice' | 'no_client';
  /** HTTP status to return when allowed=false. */
  status?: number;
  /** Count of completed entities to date (for trial UI: "X of 3 used"). */
  completedCount: number;
  /** True if the client has an active saved Stripe payment method. */
  hasPaymentMethod: boolean;
  /** Free entities still remaining under the trial (0 once used up). */
  trialRemaining: number;
  /** True if client has at least one invoice paid within the last 90 days. */
  hasRecentPaidInvoice: boolean;
}

interface GateClient {
  stripe_payment_method_id?: string | null;
  payment_method_status?: string | null;
  free_trial?: boolean | null;
  mercury_customer_id?: string | null;
}

/**
 * Compute whether the client can place a new order. Pure function once
 * the inputs are loaded — keeps the gate easy to test.
 *
 * @param adminSupabase  Service-role client (needed to count completed entities).
 * @param clientId       UUID of the client placing the order. Required.
 */
export async function checkOrderGate(
  adminSupabase: SupabaseClient,
  clientId: string | null,
): Promise<OrderGateResult> {
  if (!clientId) {
    return {
      allowed: false,
      reason: 'no_client',
      status: 400,
      completedCount: 0,
      hasPaymentMethod: false,
      trialRemaining: 0,
      hasRecentPaidInvoice: false,
    };
  }

  // Pull the three facts we need in parallel — all cheap aggregates:
  //   • payment_method state (Stripe card on file?)
  //   • count of completed entities (trial counter)
  //   • count of recent paid invoices (current-paying-customer signal)
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const clientQ = adminSupabase
    .from('clients')
    .select('stripe_payment_method_id, payment_method_status, free_trial, mercury_customer_id')
    .eq('id', clientId)
    .single();
  const countQ = adminSupabase
    .from('request_entities')
    .select('id, requests!inner(client_id)', { count: 'exact', head: true })
    .eq('requests.client_id', clientId)
    .eq('status', 'completed');
  // Recent paid invoices — `paid_at` is the canonical "money received" timestamp
  // (set by both the Mercury reconcile cron and the Stripe webhook). Falling
  // back to `paid` status alone catches historical rows that didn't set paid_at.
  const recentPaidQ = adminSupabase
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('status', 'paid')
    .gte('paid_at', ninetyDaysAgo.toISOString());

  const [clientRes, countRes, recentPaidRes] = await Promise.all([clientQ, countQ, recentPaidQ]);
  const client = (clientRes as any).data as GateClient | null;
  const completedCount = (countRes as any).count as number | null;
  const recentPaidCount = (recentPaidRes as any).count as number | null;

  const completed = completedCount ?? 0;
  const hasPaymentMethod =
    !!client?.stripe_payment_method_id && client?.payment_method_status === 'active';
  const trialRemaining = Math.max(0, TRIAL_FREE_ENTITIES - completed);
  const hasRecentPaidInvoice = (recentPaidCount ?? 0) > 0;
  // 4th condition: established Mercury account. free_trial=false means admin
  // has flipped them off trial (manual onboarding step), and a Mercury
  // customer ID means they're set up for ACH billing. Catches the case
  // where a real customer (e.g., Cal Statewide) has been onboarded but
  // hasn't generated their first paid invoice yet — without this they'd
  // get blocked the day their trial ends.
  const isEstablishedAccount =
    client?.free_trial === false && !!client?.mercury_customer_id;

  if (trialRemaining > 0 || hasPaymentMethod || hasRecentPaidInvoice || isEstablishedAccount) {
    return {
      allowed: true,
      completedCount: completed,
      hasPaymentMethod,
      trialRemaining,
      hasRecentPaidInvoice,
    };
  }

  return {
    allowed: false,
    reason: 'trial_exhausted_no_payment_method_no_recent_paid_invoice',
    status: 402, // Payment Required
    completedCount: completed,
    hasPaymentMethod,
    trialRemaining,
    hasRecentPaidInvoice,
  };
}

/**
 * Standard JSON error body for blocked orders. Keeps the message shape
 * consistent across CSV/PDF/email intake endpoints.
 */
export function buildOrderGateErrorBody(gate: OrderGateResult) {
  const isTrialBlock = gate.reason === 'trial_exhausted_no_payment_method_no_recent_paid_invoice';
  return {
    error: isTrialBlock
      ? `Free trial used (${gate.completedCount}/${TRIAL_FREE_ENTITIES}) and no recent paid invoice on file. Ask your manager to add a payment method, OR contact matt@moderntax.io to confirm your account is current — paying customers are not gated by this check.`
      : 'Account not configured for orders. Contact support.',
    code: gate.reason,
    cta: isTrialBlock
      ? { label: 'Add payment method', href: '/payment-method' }
      : null,
    completed_count: gate.completedCount,
    trial_remaining: gate.trialRemaining,
    has_recent_paid_invoice: gate.hasRecentPaidInvoice,
  };
}
