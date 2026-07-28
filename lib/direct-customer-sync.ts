/**
 * Direct-customer sync — keep the `gross_receipts.direct_customer` flag on
 * entities in step with who is actually PAYING us as a ModernTax Direct client.
 *
 * Two sources, unioned:
 *   1. Mercury paid invoices — any paying customer that is NOT one of our
 *      B2B partner/lender clients (those are the transcript-verification
 *      channel, not Direct). Matched to entities by name.
 *   2. The "ModernTax Direct" client itself — every entity under it is Direct
 *      by definition (Marquis-style Stripe prepays that never touch Mercury).
 *
 * Idempotent: re-running re-computes and overwrites the flag. Safe to schedule.
 * The cron at /api/cron/mercury-direct-sync calls this weekly.
 *
 * Matt 2026-07-28.
 */

import { listMercuryInvoices, listMercuryCustomers } from '@/lib/mercury';
import { validateEmailDeliverable } from '@/lib/email-validate';

/**
 * Name fragments identifying our B2B partner/lender clients — these are the
 * transcript-verification channel and must NEVER be tagged as Direct
 * (avoids commingling the channels). Tunable in one place.
 */
export const PARTNER_CLIENT_MATCHERS = [
  'centerstone', 'statewide', 'taxtaker', 'clearfirm', 'employer',
  'recruiter', 'business finance', 'collective', 'impactica',
];

export function isPartnerName(name: string | null | undefined): boolean {
  const n = (name || '').toLowerCase();
  return PARTNER_CLIENT_MATCHERS.some((m) => n.includes(m));
}

export interface DirectPayer {
  name: string;
  email: string | null;
  paid: number;
  source: 'mercury';
}

export interface SyncResult {
  dryRun: boolean;
  directPayers: DirectPayer[];
  taggedEntities: { entityId: string; entityName: string; source: string; amount: number | null }[];
  directClientEntities: number;
  /** Contacts whose email won't deliver (bad format / no MX) — need attention. */
  undeliverable: { entityName: string; email: string; reason: string }[];
  errors: string[];
}

/**
 * Recompute + persist the Direct-customer flag across all entities.
 * `dryRun` computes the plan without writing.
 */
export async function syncDirectCustomersFromMercury(
  admin: any,
  opts: { dryRun?: boolean } = {},
): Promise<SyncResult> {
  const dryRun = !!opts.dryRun;
  const errors: string[] = [];
  const taggedEntities: SyncResult['taggedEntities'] = [];
  const undeliverable: SyncResult['undeliverable'] = [];

  // ── 1. Mercury paid customers → Direct payers ─────────────────────────────
  let directPayers: DirectPayer[] = [];
  try {
    const [invoices, customers] = await Promise.all([listMercuryInvoices(), listMercuryCustomers()]);
    const byId = new Map(customers.map((c) => [c.id, c]));
    const paidByCust = new Map<string, number>();
    for (const iv of invoices) {
      if ((iv.status || '').toLowerCase() === 'paid') {
        paidByCust.set(iv.customerId, (paidByCust.get(iv.customerId) || 0) + (iv.amount || 0));
      }
    }
    for (const [cid, paid] of paidByCust) {
      const c = byId.get(cid);
      if (!c || isPartnerName(c.name)) continue;
      directPayers.push({ name: c.name, email: c.email || null, paid, source: 'mercury' });
    }
  } catch (e: any) {
    errors.push(`Mercury fetch failed: ${e?.message || e}`);
  }

  const nowIso = new Date().toISOString();
  async function tag(entity: any, source: string, amount: number | null, email: string | null) {
    const gr = entity.gross_receipts || {};
    const resolvedEmail = email || gr.direct_customer?.email || gr.owner_contact?.email || null;

    // Validate deliverability (format + MX) so a dead/typo'd domain is flagged
    // before the monthly check-in tries to send to it.
    const check = await validateEmailDeliverable(resolvedEmail);
    if (resolvedEmail && !check.valid) {
      undeliverable.push({ entityName: entity.entity_name, email: resolvedEmail, reason: check.reason });
    }

    const next = {
      ...gr,
      direct_customer: {
        ...(gr.direct_customer || {}),
        paying: true,
        source,
        amount: amount ?? gr.direct_customer?.amount ?? null,
        email: resolvedEmail,
        email_check: { valid: check.valid, reason: check.reason, checked_at: check.checkedAt },
        synced_at: nowIso,
      },
    };
    if (!dryRun) {
      const { error } = await admin.from('request_entities').update({ gross_receipts: next }).eq('id', entity.id);
      if (error) { errors.push(`tag ${entity.id}: ${error.message}`); return; }
    }
    taggedEntities.push({ entityId: entity.id, entityName: entity.entity_name, source, amount });
  }

  // ── 2. "ModernTax Direct" client entities ─────────────────────────────────
  let directClientEntities = 0;
  try {
    const { data: dc } = await admin.from('clients').select('id').ilike('name', '%ModernTax Direct%');
    const ids = (dc || []).map((c: any) => c.id);
    if (ids.length) {
      const { data: reqs } = await admin.from('requests').select('id').in('client_id', ids);
      const reqIds = (reqs || []).map((r: any) => r.id);
      if (reqIds.length) {
        const { data: ents } = await admin.from('request_entities')
          .select('id, entity_name, gross_receipts').in('request_id', reqIds);
        for (const e of ents || []) { await tag(e, 'direct_client', null, null); directClientEntities++; }
      }
    }
  } catch (e: any) {
    errors.push(`Direct-client sweep failed: ${e?.message || e}`);
  }

  // ── 3. Match Mercury payers → entities by name ────────────────────────────
  for (const p of directPayers) {
    try {
      // Use a couple of significant tokens from the customer name to match.
      const token = p.name.replace(/,?\s+(inc|llc|corp|co|ltd)\.?$/i, '').trim().split(/\s+/).slice(0, 2).join(' ');
      const { data: ents } = await admin.from('request_entities')
        .select('id, entity_name, gross_receipts').ilike('entity_name', `%${token}%`);
      for (const e of ents || []) await tag(e, 'mercury', p.paid, p.email);
    } catch (e: any) {
      errors.push(`match "${p.name}": ${e?.message || e}`);
    }
  }

  return { dryRun, directPayers, taggedEntities, directClientEntities, undeliverable, errors };
}
