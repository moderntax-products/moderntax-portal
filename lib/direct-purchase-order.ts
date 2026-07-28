/**
 * ModernTax Direct — Purchase Order (PO) model.
 *
 * A Direct PO is a taxpayer-approved, multi-line quote for OUTCOME services
 * (recover refunds / file back taxes / resolve liabilities). It is the missing
 * primitive the codebase never had: today every Stripe charge is a bare,
 * single-line Checkout Session created post-hoc. The PO lets us assemble the
 * services a taxpayer's *detected* situation calls for into one line-itemed
 * document they can see, approve, and pay in a single Stripe checkout.
 *
 * Storage: persisted on `request_entities.gross_receipts.purchase_order`
 * (JSONB), consistent with how every other Direct sub-state lives there. No
 * schema migration required.
 *
 * Money rules:
 *   - `flat` / `per_year` services are billed up front → they make up the
 *     Stripe `chargeableTotal`.
 *   - `contingency` services (ERC / refund recovery) are billed only on
 *     success (a % of what we actually recover). They appear on the PO for
 *     transparency but are EXCLUDED from the Stripe total — you never prepay a
 *     contingency fee. Their `amount` is an *estimate* off the detected
 *     recoverable figure.
 *   - Account credit (e.g. a Direct deposit) is applied against the
 *     chargeable total, never against contingency.
 */

import {
  DIRECT_SERVICE_CATALOG,
  getDirectService,
  RATE_RECOVERY_CONTINGENCY,
  TRUST_FUND_RATIO,
  PREMIUM_PAYROLL_THRESHOLD,
  PRICE_FTD_LOCKDOWN,
  PRICE_TRUST_FUND_IA,
  PRICE_EXEC_SHIELD,
  velocityPhaseFee,
  type DirectBilling,
} from './pricing';

export type OutcomeKey = 'recover_refunds' | 'file_back_taxes' | 'resolve_liabilities';
export type POStatus = 'draft' | 'approved' | 'paid' | 'void';

export interface POLineItem {
  code: string;
  label: string;
  description: string;
  outcome: OutcomeKey;
  billing: DirectBilling;
  qty: number;
  unit: string;
  unitPrice: number;
  /** Extended amount. For contingency lines this is an ESTIMATE, not a charge. */
  amount: number;
  /** True for lines NOT charged in today's checkout (contingency or a later phase). */
  billLater: boolean;
  /** Human label for when this line bills ("Due today", "At IA filing", "Billed on recovery"). */
  billTrigger?: string;
  /** For contingency lines: the recoverable figure the estimate is based on. */
  basis?: number;
}

export interface DirectPurchaseOrder {
  poNumber: string;
  entityId: string;
  entityName: string;
  status: POStatus;
  createdAt: string;
  /** Outcomes represented, for the UI's outcome-track framing. */
  outcomes: OutcomeKey[];
  lineItems: POLineItem[];
  /** Sum of line amounts billed in today's checkout (billLater === false). */
  subtotal: number;
  /** Sum of deferred/contingency line amounts billed later (phases / on success). */
  deferredTotal: number;
  /** Full engagement value = subtotal + deferredTotal (headline figure). */
  engagementTotal: number;
  /** Account credit applied against the chargeable subtotal. */
  creditApplied: number;
  /** What the taxpayer pays now via Stripe: max(0, subtotal - creditApplied). */
  chargeableTotal: number;
  notes?: string;
  approvedAt?: string;
  paidAt?: string;
  stripeRef?: string;
}

/** A detected issue surfaced from the entity's transcripts / gross_receipts. */
export interface DetectedSituation {
  /** Unpaid federal payroll (trust-fund) tax — the S3-style case. */
  payrollBalance?: number;
  payrollPayoff?: number;
  payrollQuartersOpen?: number;
  /** Trust-fund portion of the payroll balance (drives TFRP + phase pricing). */
  trustFundExposure?: number;
  /** True when no lien/levy/RO code appears yet — the pre-enforcement window. */
  preEnforcement?: boolean;
  /** S-corp / shareholder exposure flag (drives TFRP framing). */
  shareholderExposure?: boolean;
  /** Undelivered ERC / refund dollars recoverable (Form 3911). */
  undeliveredRefunds?: number;
  undeliveredCount?: number;
  /** Delinquent federal return years not yet filed. */
  unfiledYears?: string[];
  /** States needing a resolution/payment plan. */
  states?: string[];
  /** Any assessed balance carrying penalties (drives penalty-abatement offer). */
  hasPenalties?: boolean;
}

/**
 * Read the entity's stored Direct state into a normalized situation. Prefers
 * concrete pre-computed sub-objects (payroll_liability_report, erc_recovery,
 * resolution, filing) so the page never has to re-parse transcript HTML.
 */
export function detectSituation(grossReceipts: any, formType?: string): DetectedSituation {
  const gr = grossReceipts || {};
  const s: DetectedSituation = {};

  const payroll = gr.payroll_liability_report;
  if (payroll && Number(payroll.total_account_balance) > 0) {
    s.payrollBalance = Number(payroll.total_account_balance) || 0;
    s.payrollPayoff = Number(payroll.total_balance_plus_accruals) || s.payrollBalance;
    s.payrollQuartersOpen = Number(payroll.quarters_with_balance) || undefined;
    s.hasPenalties = true;
    // Trust-fund portion (withheld income + employee FICA) — the piece that
    // creates personal TFRP exposure and anchors the phase pricing.
    s.trustFundExposure = Math.round(s.payrollBalance * TRUST_FUND_RATIO);
    // Pre-enforcement window: the payroll report found no lien/levy/RO codes.
    // (report.enforcement_started, when present, is true only if any appeared.)
    s.preEnforcement = payroll.enforcement_started !== true;
    // Payroll trust-fund debt on an S-corp/1120S carries owner (TFRP) exposure.
    if ((formType || '').toUpperCase().includes('1120S') || gr.shareholder_exposure) {
      s.shareholderExposure = true;
    }
  }

  const erc = gr.erc_recovery;
  const undelivered = Number(erc?.total_undelivered ?? erc?.recovery?.total_undelivered);
  if (Number.isFinite(undelivered) && undelivered > 0) {
    s.undeliveredRefunds = undelivered;
    s.undeliveredCount = Number(erc?.undelivered_count ?? erc?.recovery?.count) || 1;
  }

  const unfiled: string[] =
    (Array.isArray(gr.resolution?.unfiled_years) && gr.resolution.unfiled_years) ||
    (Array.isArray(gr.filing?.unfiled_years) && gr.filing.unfiled_years) ||
    [];
  if (unfiled.length) s.unfiledYears = unfiled.map(String);
  else if (Number(gr.filing?.years_filed) > 0) {
    // Team recorded a filing count but not the specific years.
    s.unfiledYears = Array.from({ length: Number(gr.filing.years_filed) }, (_, i) => `yr${i + 1}`);
  }

  const states: string[] = Array.isArray(gr.resolution?.states) ? gr.resolution.states.map(String) : [];
  if (states.length) s.states = states;

  return s;
}

/** Turn a detected situation into recommended PO line items. */
export function recommendLineItems(sit: DetectedSituation): POLineItem[] {
  const items: POLineItem[] = [];
  const push = (code: string, qty: number, over?: Partial<POLineItem>) => {
    const svc = getDirectService(code);
    if (!svc || qty <= 0) return;
    const isContingency = svc.billing === 'contingency';
    const amount = isContingency
      ? Math.round((over?.basis || 0) * svc.unitPrice * 100) / 100
      : Math.round(svc.unitPrice * qty * 100) / 100;
    items.push({
      code: svc.code,
      label: svc.label,
      description: svc.blurb,
      outcome: svc.outcome,
      billing: svc.billing,
      qty,
      unit: svc.unit,
      unitPrice: svc.unitPrice,
      amount,
      billLater: isContingency,
      ...over,
    });
  };

  // Recover refunds — contingency, estimated off the undelivered figure.
  if (sit.undeliveredRefunds && sit.undeliveredRefunds > 0) {
    push('erc_recovery', sit.undeliveredCount || 1, {
      basis: sit.undeliveredRefunds,
      description: `We recover the ${sit.undeliveredCount || 1} undelivered refund${
        (sit.undeliveredCount || 1) === 1 ? '' : 's'
      } (~${usd(sit.undeliveredRefunds)}) sitting at the IRS. Our fee is ${Math.round(
        RATE_RECOVERY_CONTINGENCY * 100,
      )}% of what we actually recover — nothing up front.`,
    });
  }

  // File back taxes — per delinquent year.
  if (sit.unfiledYears && sit.unfiledYears.length) {
    push('backyear_filing', sit.unfiledYears.length, {
      description: `We prepare and file your ${sit.unfiledYears.length} delinquent federal return${
        sit.unfiledYears.length === 1 ? '' : 's'
      } to stop the penalty clock and claim any refunds still in the window.`,
    });
  }

  // Resolve liabilities — payroll case (the S3 pattern).
  if (sit.payrollBalance && sit.payrollBalance > 0) {
    const trustFund = sit.trustFundExposure || Math.round(sit.payrollBalance * 0.67);

    if (sit.payrollBalance >= PREMIUM_PAYROLL_THRESHOLD) {
      // Premium velocity engagement — a phased pre-emptive strike that
      // intercepts the automated enforcement stream before a Revenue Officer
      // is assigned. Only Phase 1 is charged today (the immediate strike); the
      // later phases bill as they begin. Penalty relief is folded in, so no
      // standalone abatement line here.
      const ftd = velocityPhaseFee(PRICE_FTD_LOCKDOWN, trustFund);
      const ia = velocityPhaseFee(PRICE_TRUST_FUND_IA, trustFund);
      const shield = velocityPhaseFee(PRICE_EXEC_SHIELD, trustFund);
      const window = sit.preEnforcement
        ? 'While your transcript is still clean — no lien, no levy notice, no Revenue Officer — '
        : '';

      push('ftd_lockdown', 1, { unitPrice: ftd, amount: ftd, billLater: false, billTrigger: 'Due today to begin' });
      push('trust_fund_ia', 1, {
        unitPrice: ia,
        amount: ia,
        billLater: true,
        billTrigger: 'At IA filing',
        description: `${window}we establish a complex in-business Installment Agreement on ${usd(
          sit.payrollPayoff || sit.payrollBalance,
        )} through Centralized Case Management — negotiating a payment structure on your cash flow before the case reaches a field agent.`,
      });
      push('exec_shielding', 1, {
        unitPrice: shield,
        amount: shield,
        billLater: true,
        billTrigger: 'At 433-B submission',
        description: `We prepare Form 433-B and direct every dollar to the oldest trust-fund quarters first (designated payments), paying down the ~${usd(
          trustFund,
        )} trust-fund portion to shield the owners from personal Trust Fund Recovery Penalty — without waiting on IRS Form 1153.`,
      });
    } else {
      // Smaller payroll balance — flat resolution retainer + penalty abatement.
      push('payroll_resolution', 1, {
        description: `We represent the business on ${usd(
          sit.payrollPayoff || sit.payrollBalance,
        )} of unpaid payroll tax and negotiate an installment agreement or offer.`,
      });
      if (sit.hasPenalties) push('penalty_abatement', 1);
    }
  } else if (sit.hasPenalties) {
    // Non-payroll penalties → standalone abatement.
    push('penalty_abatement', 1);
  }

  // State plans — per state.
  if (sit.states && sit.states.length) push('state_resolution', sit.states.length);

  return items;
}

/** Assemble a full PO from line items + context. Pure; caller persists it. */
export function buildPurchaseOrder(args: {
  entityId: string;
  entityName: string;
  lineItems: POLineItem[];
  creditAvailable?: number;
  createdAt: string;
  poNumber: string;
  status?: POStatus;
  notes?: string;
}): DirectPurchaseOrder {
  const { entityId, entityName, lineItems, createdAt, poNumber } = args;
  // Default each line's bill trigger so the UI always has a label.
  const items = lineItems.map((l) => ({
    ...l,
    billTrigger: l.billTrigger || (l.billLater ? 'Billed on recovery' : 'Due today'),
  }));
  const subtotal = round2(items.filter((l) => !l.billLater).reduce((n, l) => n + l.amount, 0));
  const deferredTotal = round2(items.filter((l) => l.billLater).reduce((n, l) => n + l.amount, 0));
  const engagementTotal = round2(subtotal + deferredTotal);
  const creditApplied = Math.min(Math.max(0, args.creditAvailable || 0), subtotal);
  const chargeableTotal = round2(Math.max(0, subtotal - creditApplied));
  const outcomes = Array.from(new Set(items.map((l) => l.outcome)));
  return {
    poNumber,
    entityId,
    entityName,
    status: args.status || 'draft',
    createdAt,
    outcomes,
    lineItems: items,
    subtotal,
    deferredTotal,
    engagementTotal,
    creditApplied,
    chargeableTotal,
    notes: args.notes,
  };
}

/** Deterministic PO number from the entity id + creation time (no RNG). */
export function makePoNumber(entityId: string, createdAtIso: string): string {
  const short = entityId.replace(/-/g, '').slice(0, 6).toUpperCase();
  const stamp = createdAtIso.slice(0, 10).replace(/-/g, '');
  return `MT-D-${short}-${stamp}`;
}

export const OUTCOME_META: Record<OutcomeKey, { label: string; tagline: string; icon: string }> = {
  recover_refunds: { label: 'Recover your refunds', tagline: 'Money the IRS owes you', icon: '💵' },
  file_back_taxes: { label: 'File your back taxes', tagline: 'Get back into compliance', icon: '📄' },
  resolve_liabilities: { label: 'Resolve what you owe', tagline: 'Settle the balance, protect the owners', icon: '🛡️' },
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function usd(n: number): string {
  return `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

// Re-export the catalog for convenience at call sites.
export { DIRECT_SERVICE_CATALOG };
