/**
 * Order gate — central rule for "can this client place a new order?"
 *
 * 2026-05-14 policy update (Matt's directive — TaxTaker onboarding):
 * Mercury payment-method enrollment is now REQUIRED for new orders.
 * Avoiding Stripe until existing Stripe processing balance settles.
 * Stripe payment method + free-trial + recent-paid-invoice no longer
 * bypass on their own — they only matter as supporting context.
 *
 * Rules (in order — first match wins):
 *   1. SANDBOX EXEMPT: clients.slug ending in `-sandbox` are auto-allowed
 *      (Vine / Collective / Moxie demo accounts have no Mercury setup
 *      by design and need to remain curl-able for prospects).
 *   2. EXPLICIT BYPASS: clients.bypass_payment_paywall=TRUE allowed.
 *      Currently set for Centerstone, Cal Statewide, Clearfirm via the
 *      migration-mercury-paywall.sql migration.
 *   3. MERCURY ENROLLED: clients.mercury_customer_id IS NOT NULL allowed.
 *      Set by the user via /invoicing → Payment Settings → Enroll Mercury
 *      button (which POSTs to /api/billing/setup-mercury).
 *   4. OTHERWISE: blocked with 402 Payment Required pointing to /invoicing.
 *
 * Note: free trial (3 free entities) is no longer a bypass — clients must
 * complete Mercury enrollment to submit ANY new request. This is intentional;
 * Mercury enrollment is a 2-min self-serve flow on /invoicing and the
 * one-time friction is preferable to invoicing chase down the line.
 *
 * Used by:
 *   - app/api/upload/csv/route.ts  (intake)
 *   - app/api/upload/pdf/route.ts  (intake)
 *   - app/api/admin/email-intake/route.ts (intake)
 *   - app/api/intake/transcript/route.ts (partner v1 API)
 *   - app/page.tsx + dashboard banners (UI surfaces)
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const TRIAL_FREE_ENTITIES = 3;

export interface OrderGateResult {
  allowed: boolean;
  /**
   * Why the order is blocked. Always set when allowed=false.
   *
   * - `mercury_required` — primary block, post-2026-05-14 policy
   * - `no_client` — clientId was null/missing
   */
  reason?: 'mercury_required' | 'no_client';
  /** HTTP status to return when allowed=false. */
  status?: number;
  /** Count of completed entities to date (for UI display only — no longer a bypass). */
  completedCount: number;
  /** True if the client has an active saved Stripe payment method (display only). */
  hasPaymentMethod: boolean;
  /**
   * Free entities still remaining under the trial (0 once used up).
   * Display only — no longer bypasses the Mercury gate.
   */
  trialRemaining: number;
  /** True if client has at least one invoice paid within the last 90 days (display only). */
  hasRecentPaidInvoice: boolean;
  /** True if Mercury customer record exists (the actual gate condition). */
  hasMercuryEnrolled: boolean;
  /** True if the bypass flag is set on this client. */
  hasBypass: boolean;
  /** True if the client is a sandbox (slug ends in -sandbox). */
  isSandbox: boolean;
  /** Client name for use in error messages / dashboards. */
  clientName?: string | null;
}

interface GateClient {
  name?: string | null;
  slug?: string | null;
  stripe_payment_method_id?: string | null;
  payment_method_status?: string | null;
  free_trial?: boolean | null;
  mercury_customer_id?: string | null;
  bypass_payment_paywall?: boolean | null;
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
      hasMercuryEnrolled: false,
      hasBypass: false,
      isSandbox: false,
      clientName: null,
    };
  }

  // Two-phase select on bypass_payment_paywall — the column is added by
  // supabase/migration-mercury-paywall.sql and may not be applied yet in
  // every environment. Falling back keeps the gate working pre-migration
  // (sandbox + mercury rules still fire correctly).
  const baseSelect = 'name, slug, stripe_payment_method_id, payment_method_status, free_trial, mercury_customer_id';
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  let client: GateClient | null = null;
  {
    const r = await adminSupabase
      .from('clients')
      .select(`${baseSelect}, bypass_payment_paywall`)
      .eq('id', clientId)
      .single();
    if (r.error && /bypass_payment_paywall|column .* does not exist|42703/i.test(r.error.message || '')) {
      const r2 = await adminSupabase
        .from('clients')
        .select(baseSelect)
        .eq('id', clientId)
        .single();
      client = r2.data ? { ...(r2.data as any), bypass_payment_paywall: false } : null;
    } else {
      client = (r.data as any) ?? null;
    }
  }

  // Display-only counts (kept for UI panels — trial counter, AR aging, etc.)
  // No longer affect the allow/block decision under the 2026-05-14 policy.
  const countQ = adminSupabase
    .from('request_entities')
    .select('id, requests!inner(client_id)', { count: 'exact', head: true })
    .eq('requests.client_id', clientId)
    .eq('status', 'completed');
  const recentPaidQ = adminSupabase
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('status', 'paid')
    .gte('paid_at', ninetyDaysAgo.toISOString());

  const [countRes, recentPaidRes] = await Promise.all([countQ, recentPaidQ]);
  const completedCount = (countRes as any).count as number | null;
  const recentPaidCount = (recentPaidRes as any).count as number | null;

  const completed = completedCount ?? 0;
  const hasPaymentMethod =
    !!client?.stripe_payment_method_id && client?.payment_method_status === 'active';
  const trialRemaining = Math.max(0, TRIAL_FREE_ENTITIES - completed);
  const hasRecentPaidInvoice = (recentPaidCount ?? 0) > 0;
  const hasMercuryEnrolled = !!client?.mercury_customer_id;
  const hasBypass = !!client?.bypass_payment_paywall;
  const isSandbox = !!(client?.slug && /-sandbox$/i.test(client.slug));

  // Common payload shared between allowed + blocked branches.
  const baseResult = {
    completedCount: completed,
    hasPaymentMethod,
    trialRemaining,
    hasRecentPaidInvoice,
    hasMercuryEnrolled,
    hasBypass,
    isSandbox,
    clientName: client?.name ?? null,
  };

  // Allow: sandbox OR explicit bypass OR Mercury enrolled.
  if (isSandbox || hasBypass || hasMercuryEnrolled) {
    return { allowed: true, ...baseResult };
  }

  // Otherwise blocked: Mercury enrollment required.
  return {
    allowed: false,
    reason: 'mercury_required',
    status: 402,
    ...baseResult,
  };
}

/**
 * Standard JSON error body for blocked orders. Keeps the message shape
 * consistent across CSV/PDF/email intake endpoints.
 */
export function buildOrderGateErrorBody(gate: OrderGateResult) {
  const isMercuryBlock = gate.reason === 'mercury_required';
  return {
    error: isMercuryBlock
      ? `Payment method required. Connect your Mercury account to submit new requests — open Payment Settings on the Invoicing page (2-min self-serve flow). Existing in-flight requests are unaffected.`
      : 'Account not configured for orders. Contact support.',
    code: gate.reason,
    client_name: gate.clientName,
    cta: isMercuryBlock
      ? { label: 'Connect Mercury account', href: '/invoicing#payment-settings' }
      : null,
    enroll_url: isMercuryBlock ? 'https://portal.moderntax.io/invoicing' : null,
    next_steps: isMercuryBlock ? [
      'Sign in to portal.moderntax.io and open the Invoicing page.',
      'In the Payment Settings card, fill in AP email + billing address (one-time), then click Enroll Mercury.',
      'Mercury auto-creates the customer record + sends future invoices to your AP email — ACH-payable from your bank in one click.',
      'Existing in-flight requests are unaffected; only NEW requests are gated until enrollment completes.',
    ] : null,
    // Display context (no longer affects allow/block decisions but useful for UI)
    completed_count: gate.completedCount,
    trial_remaining: gate.trialRemaining,
    has_recent_paid_invoice: gate.hasRecentPaidInvoice,
    has_mercury_enrolled: gate.hasMercuryEnrolled,
    has_bypass: gate.hasBypass,
    is_sandbox: gate.isSandbox,
  };
}
