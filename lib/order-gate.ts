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
 *   4. PER-CLIENT TRIAL ALLOWANCE: clients.trial_entities_allowed > 0 AND
 *      lifetime completed_count < trial_entities_allowed. Lets Matt
 *      negotiate case-by-case trial scope per client (e.g., Banc of
 *      California gets 2 entities, Enterprise Financial gets 3, etc.).
 *      No decrementer needed — completed_count counts against the cap
 *      automatically at gate-check time.
 *   5. OTHERWISE: blocked with 402 Payment Required pointing to /invoicing.
 *
 * The old global TRIAL_FREE_ENTITIES = 3 constant is gone. Trial allowance
 * is now strictly opt-in per client via the trial_entities_allowed column
 * (see migration-trial-entities-allowed.sql). All other free_trial=true
 * clients default to 0 trial entities — they must enroll Mercury via
 * /invoicing to submit. Self-serve flow takes ~2 minutes.
 *
 * Used by:
 *   - app/api/upload/csv/route.ts  (intake)
 *   - app/api/upload/pdf/route.ts  (intake)
 *   - app/api/admin/email-intake/route.ts (intake)
 *   - app/api/intake/transcript/route.ts (partner v1 API)
 *   - app/page.tsx + dashboard banners (UI surfaces)
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * @deprecated since 2026-05-14 — trial allowance is now per-client via
 * `clients.trial_entities_allowed`. Kept exported as a fallback only;
 * new code should not reference it.
 */
export const TRIAL_FREE_ENTITIES = 3;

export interface OrderGateResult {
  allowed: boolean;
  /**
   * Why the order is blocked. Always set when allowed=false.
   *
   * - `mercury_required` — primary block, post-2026-05-14 policy
   * - `no_client` — clientId was null/missing
   */
  reason?: 'mercury_required' | 'no_client' | 'card_required' | 'credits_required';
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
  /** Per-client trial cap — see migration-trial-entities-allowed.sql */
  trial_entities_allowed?: number | null;
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

  // Three-phase select to handle environments where either the
  // bypass_payment_paywall column (migration-mercury-paywall.sql) or the
  // trial_entities_allowed column (migration-trial-entities-allowed.sql)
  // hasn't been applied yet. Tries the full select first, falls back to
  // dropping each missing column individually so the gate still works
  // during a partial-migration window.
  const baseSelect = 'name, slug, stripe_payment_method_id, payment_method_status, free_trial, mercury_customer_id';
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  let client: GateClient | null = null;
  {
    // Phase 1: try with both new columns
    const r1 = await adminSupabase
      .from('clients')
      .select(`${baseSelect}, bypass_payment_paywall, trial_entities_allowed`)
      .eq('id', clientId)
      .single();
    if (!r1.error) {
      client = (r1.data as any) ?? null;
    } else if (/trial_entities_allowed|column .* does not exist|42703/i.test(r1.error.message || '')) {
      // Phase 2: trial_entities_allowed missing — try without it
      const r2 = await adminSupabase
        .from('clients')
        .select(`${baseSelect}, bypass_payment_paywall`)
        .eq('id', clientId)
        .single();
      if (!r2.error) {
        client = r2.data ? { ...(r2.data as any), trial_entities_allowed: 0 } : null;
      } else if (/bypass_payment_paywall|column .* does not exist|42703/i.test(r2.error.message || '')) {
        // Phase 3: both missing — minimal select
        const r3 = await adminSupabase
          .from('clients')
          .select(baseSelect)
          .eq('id', clientId)
          .single();
        client = r3.data ? { ...(r3.data as any), bypass_payment_paywall: false, trial_entities_allowed: 0 } : null;
      }
    } else if (/bypass_payment_paywall|column .* does not exist|42703/i.test(r1.error.message || '')) {
      // bypass_payment_paywall missing but trial_entities_allowed might exist
      const r2 = await adminSupabase
        .from('clients')
        .select(`${baseSelect}, trial_entities_allowed`)
        .eq('id', clientId)
        .single();
      client = r2.data ? { ...(r2.data as any), bypass_payment_paywall: false } : null;
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
  const trialAllowed = client?.trial_entities_allowed ?? 0;
  const trialRemaining = Math.max(0, trialAllowed - completed);
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

  // Sandbox / explicit bypass always pass (testing + negotiated exceptions).
  if (isSandbox || hasBypass) {
    return { allowed: true, ...baseResult };
  }

  // Standard-plan clients (created on/after the 2026-06-06 cutoff) order out of
  // a prepaid credit wallet: they must have a card on file AND enough credits
  // for at least one request. Guarded fetch so pre-migration envs degrade to
  // the legacy rules below. (migration-client-credits.sql)
  let createdAt: string | null = null;
  let creditBalance = 0;
  let creditRate = 99.99;
  // Admin-granted: may consume the trial allowance with no card on file.
  // Sales-led accounts only — see migration-trial-card-exempt.sql.
  let trialCardExempt = false;
  {
    const cr = await adminSupabase.from('clients')
      .select('created_at, credit_balance, credit_rate, trial_card_exempt').eq('id', clientId).single();
    if (!cr.error && cr.data) {
      createdAt = (cr.data as any).created_at ?? null;
      creditBalance = Number((cr.data as any).credit_balance) || 0;
      creditRate = Number((cr.data as any).credit_rate) > 0 ? Number((cr.data as any).credit_rate) : 99.99;
      trialCardExempt = !!(cr.data as any).trial_card_exempt;
    } else {
      // Pre-migration fallback: retry without the newer columns so envs that
      // haven't run migration-trial-card-exempt.sql still resolve created_at.
      const cr2 = await adminSupabase.from('clients')
        .select('created_at, credit_balance, credit_rate').eq('id', clientId).single();
      if (!cr2.error && cr2.data) {
        createdAt = (cr2.data as any).created_at ?? null;
        creditBalance = Number((cr2.data as any).credit_balance) || 0;
        creditRate = Number((cr2.data as any).credit_rate) > 0 ? Number((cr2.data as any).credit_rate) : 99.99;
      } else {
        const cr3 = await adminSupabase.from('clients').select('created_at').eq('id', clientId).single();
        createdAt = cr3.data ? (cr3.data as any).created_at : null;
      }
    }
  }
  const STANDARD_PLAN_CUTOFF = '2026-06-06';
  if (!!createdAt && createdAt >= STANDARD_PLAN_CUTOFF) {
    if (hasPaymentMethod && creditBalance >= creditRate) {
      return { allowed: true, ...baseResult };
    }
    // Self-serve activation (2026-07-21): a card on file + an unused trial
    // allowance is enough for the FIRST transcript — that's the whole promise
    // of "add a card, place your first order free". Without this, the standard
    // branch returned 402 'credits_required' before the trial rules below ever
    // ran, so every self-serve signup was blocked despite a valid card.
    // trialRemaining is lifetime-capped (completed_count < trial_entities_allowed),
    // so it self-exhausts after the free pull — no decrementer needed.
    // Sales-led accounts (2026-07-22): an admin-granted trial is consumable
    // with NO card. We onboard these clients ourselves, so the card is not the
    // trust signal here — our own decision to open the account is. Business
    // Finance Capital was created post-cutoff and its manager was told she
    // could order, but every attempt 402'd on card_required.
    //
    // Deliberately NOT folded into the line above: trial_card_exempt defaults
    // to FALSE, so self-serve signups still need the card that replaced admin
    // approval. The allowance stays the cap either way — trialRemaining is
    // lifetime-capped against completed orders, so this self-exhausts.
    if ((hasPaymentMethod || trialCardExempt) && trialRemaining > 0) {
      return { allowed: true, ...baseResult };
    }
    return {
      allowed: false,
      reason: !hasPaymentMethod ? 'card_required' : 'credits_required',
      status: 402,
      ...baseResult,
    };
  }

  // Rule 3.5 (2026-06-01 trial overhaul) — trial converted + Stripe card active.
  // After auto-conversion the customer is on PAYG via Stripe off-session charges.
  const hasTrialConverted = !!((client as any)?.trial_converted_at);
  if (hasTrialConverted && hasPaymentMethod) {
    return { allowed: true, ...baseResult };
  }

  // Legacy allow: Mercury enrolled OR trial allowance remaining.
  if (hasMercuryEnrolled || trialRemaining > 0) {
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
