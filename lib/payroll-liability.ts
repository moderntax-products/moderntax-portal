/**
 * Payroll-Liability Report add-on (2026-07-25).
 *
 * SBA underwriters need to know whether a borrower owes payroll taxes — an
 * unpaid 941 balance is a federal-lien risk that can subordinate their loan.
 * This add-on pulls the entity's Form 941 (employer quarterly) account
 * transcripts and surfaces: outstanding balance by quarter, unfiled quarters,
 * and any Trust Fund Recovery Penalty exposure.
 *
 * Shape mirrors the cash-flow-pack add-on: a per-entity marker in
 * gross_receipts, a client-level auto-attach toggle, an expert instruction so
 * the right transcripts get pulled, and a single idempotent invoice line.
 *
 * The report itself reuses lib/tax-liability-report (which already parses 941
 * quarterly liabilities and TC-846 refund events) — this module is the add-on
 * plumbing, not a second liability parser.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { payrollLiabilityPrice } from '@/lib/pricing';

export interface PayrollLiabilityOrder {
  requested: true;
  /** Price captured at attach time so later rate changes don't re-bill. */
  price: number;
  /** True when billed at the prepay ($22) rate vs. the one-off ($30). */
  prepay: boolean;
  ordered_at: string;
  /** Set true once the invoice cron bills it. Idempotency guard. */
  billed?: boolean;
  /** How it landed on the order — client default vs. explicit per-order pick. */
  source: 'client_auto_attach' | 'explicit';
}

/**
 * Build the gross_receipts.payroll_liability_order marker for an entity.
 * Resolve the price from the client's billing posture (prepay vs one-off).
 */
export function buildPayrollLiabilityOrder(
  client: { credit_balance?: number | null; billing_model?: string | null } | null,
  source: PayrollLiabilityOrder['source'],
  nowIso: string,
): PayrollLiabilityOrder {
  const { price, prepay } = payrollLiabilityPrice(client);
  return { requested: true, price, prepay, ordered_at: nowIso, billed: false, source };
}

/** True if this entity carries the add-on. */
export function hasPayrollLiabilityOrder(grossReceipts: any): boolean {
  return grossReceipts?.payroll_liability_order?.requested === true;
}

/**
 * The instruction the expert sees, so they pull the RIGHT transcripts. Form
 * 941 is quarterly, so "all periods" means every quarter in range — not the
 * annual income forms the base order may have requested.
 */
export function payrollLiabilityInstruction(entityName: string): string {
  return (
    `PAYROLL-LIABILITY REPORT add-on requested for ${entityName}. ` +
    `In addition to the base order, pull Form 941 (employer quarterly payroll) ` +
    `ACCOUNT transcripts for every available quarter, and flag: (1) any ` +
    `outstanding 941 balance by quarter, (2) any unfiled quarters, and (3) any ` +
    `Trust Fund Recovery Penalty (TC 240 / civil penalty) assessments. If the ` +
    `entity has no 941 filing requirement, note that explicitly — "no payroll ` +
    `tax liability: not a 941 filer" is a valid, valuable answer for the lender.`
  );
}

/**
 * Auto-attach the add-on to every entity on a freshly-created request when the
 * client has payroll_liability_auto_attach = true. Idempotent (skips entities
 * already carrying the marker), non-fatal, and a no-op for clients without the
 * toggle — so intake routes can call it unconditionally, exactly like
 * autoGenerate8821sForRequest. Returns how many entities it stamped.
 *
 * Posts the 941-pull instruction on each stamped entity so the assigned expert
 * pulls the right transcripts, using the same entity-notes channel the base
 * intake note uses.
 */
export async function applyPayrollLiabilityAutoAttach(
  admin: SupabaseClient,
  requestId: string,
  actor: { userId: string; name: string },
): Promise<number> {
  try {
    const { data: req } = await admin
      .from('requests')
      .select('client_id')
      .eq('id', requestId)
      .single() as { data: { client_id: string } | null };
    if (!req?.client_id) return 0;

    // Guarded read: degrade cleanly if the migration hasn't been applied yet.
    const { data: client, error: clientErr } = await admin
      .from('clients')
      .select('credit_balance, billing_model, payroll_liability_auto_attach')
      .eq('id', req.client_id)
      .single() as { data: any; error: any };
    if (clientErr || !client?.payroll_liability_auto_attach) return 0;

    const { data: entities } = await admin
      .from('request_entities')
      .select('id, entity_name, gross_receipts')
      .eq('request_id', requestId) as { data: any[] | null };
    if (!entities?.length) return 0;

    const nowIso = new Date().toISOString();
    let stamped = 0;
    for (const e of entities) {
      if (hasPayrollLiabilityOrder(e.gross_receipts)) continue; // idempotent
      const order = buildPayrollLiabilityOrder(client, 'client_auto_attach', nowIso);
      await admin
        .from('request_entities')
        .update({ gross_receipts: { ...(e.gross_receipts || {}), payroll_liability_order: order } })
        .eq('id', e.id);
      // Expert instruction — best-effort, never blocks the attach.
      try {
        await (admin.from('entity_notes' as any) as any).insert({
          entity_id: e.id,
          author_id: actor.userId,
          author_role: 'system',
          author_name: actor.name,
          kind: 'instruction',
          body: payrollLiabilityInstruction(e.entity_name || 'this entity'),
        });
      } catch { /* note is non-fatal */ }
      stamped++;
    }
    return stamped;
  } catch (e) {
    console.error('[payroll-liability] auto-attach failed (order kept):', e);
    return 0;
  }
}
