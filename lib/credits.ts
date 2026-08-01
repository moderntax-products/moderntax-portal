/**
 * Prepaid-credit consumption helpers (server-only).
 *
 * Standard-plan clients pay for transcript requests out of a prepaid credit
 * wallet (clients.credit_balance) at their locked-in per-request rate
 * (clients.credit_rate). Each entity debits the rate once and is flagged
 * credit_paid=true so the Mercury invoice cron skips it.
 *
 * Graceful degrade: if the credit columns aren't migrated yet (or the client
 * isn't on the credit model), these are no-ops so existing Mercury-ACH clients
 * are unaffected.
 */
import { PRICE_STANDARD, PRICE_941_PAYROLL_SUMMARY } from './pricing';

/** True when an entity ordered a 941 payroll-liability summary add-on. */
function hasPayrollAddon(gr: any): boolean {
  return !!(gr?.payroll_liability_order || gr?.payroll_liability_report);
}

/** Is this client on the prepaid-credit model? (has ever purchased credits) */
export function isCreditClient(client: { credit_purchased_total?: number | null; credit_rate?: number | null } | null | undefined): boolean {
  return (Number(client?.credit_purchased_total) || 0) > 0;
}

/**
 * Debit `count` requests worth of credits for a set of entities. Idempotent
 * per entity via the credit_paid flag. Returns how many entities were charged
 * and the resulting balance. Throws only on a hard DB error (not on
 * insufficient funds — caller should gate with hasCreditsToOrder first).
 */
export async function debitCreditsForEntities(
  admin: any,
  clientId: string,
  entityIds: string[],
): Promise<{ charged: number; skipped: number; balanceAfter: number; rate: number }> {
  if (!entityIds.length) return { charged: 0, skipped: 0, balanceAfter: 0, rate: PRICE_STANDARD };

  const { data: client, error: cErr } = await admin.from('clients')
    .select('id, credit_balance, credit_rate, credit_purchased_total')
    .eq('id', clientId).single() as { data: any; error: any };
  // Column-missing / not-a-credit-client → no-op (existing ACH clients).
  if (cErr || !client || (Number(client.credit_purchased_total) || 0) === 0) {
    return { charged: 0, skipped: entityIds.length, balanceAfter: Number(client?.credit_balance) || 0, rate: PRICE_STANDARD };
  }

  const rate = Number(client.credit_rate) > 0 ? Number(client.credit_rate) : PRICE_STANDARD;
  let balance = Number(client.credit_balance) || 0;

  // Only charge entities not already credit_paid (idempotency). Pull
  // gross_receipts so we can add the 941 payroll-liability add-on ($30 flat)
  // to the same draw when the entity ordered it — itemized in the ledger note.
  const { data: ents } = await admin.from('request_entities')
    .select('id, credit_paid, gross_receipts').in('id', entityIds) as { data: any[] | null };
  const unpaid = (ents || []).filter((e) => !e.credit_paid);

  let charged = 0;
  for (const e of unpaid) {
    const eid = e.id;
    const payroll = hasPayrollAddon(e.gross_receipts) ? PRICE_941_PAYROLL_SUMMARY : 0;
    const amount = Math.round((rate + payroll) * 100) / 100;
    if (balance < amount) break; // out of funds — stop (caller should have gated)
    balance = Math.round((balance - amount) * 100) / 100;
    const { error: upErr } = await admin.from('request_entities')
      .update({ credit_paid: true } as any).eq('id', eid).eq('credit_paid', false);
    if (upErr) continue;
    await (admin.from('credit_ledger' as any) as any).insert({
      client_id: clientId, kind: 'debit', amount: -amount, balance_after: balance, entity_id: eid,
      note: payroll > 0 ? 'transcript request + 941 payroll liability summary' : 'transcript request',
    });
    charged++;
  }
  if (charged > 0) {
    await admin.from('clients').update({ credit_balance: balance } as any).eq('id', clientId);
  }
  return { charged, skipped: entityIds.length - charged, balanceAfter: balance, rate };
}
