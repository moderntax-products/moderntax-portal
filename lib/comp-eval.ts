/**
 * Comped evaluation pulls — track them, don't bill them.
 *
 * Some accounts run a paid eval before committing to volume. Biz2Credit
 * (Shaurya Kabra) is comparing ModernTax real transcripts head-to-head with
 * Tax Guard before turning on high-volume monthly ordering; Matt promised the
 * eval pulls are on us (2026-07-23). Those orders should still run and be
 * TRACKED like any other — they just must not appear on an invoice.
 *
 * Scoping matters here. Biz2Credit's user sits on the shared ClearFirm reseller
 * client (ClearFirm resells with downstream users on their own domains), so we
 * comp by USER, never by client — ClearFirm's real reseller volume bills
 * normally at its contracted rate. We comp a per-user CAP of the earliest
 * completed entities, so the comp naturally exhausts once the eval is over and
 * paid volume begins.
 *
 * The billing engines (app/api/cron/auto-invoice + the admin/invoices preview)
 * ask this module for the set of entity ids to leave off the invoice, and skip
 * them exactly like a pre-billed or credit-paid entity.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface CompRule {
  /** profiles.id of the user whose eval pulls are comped. */
  userId: string;
  /** Number of earliest completed entities to comp before billing resumes. */
  cap: number;
  /** Human context — shows up nowhere billable, just for the next reader. */
  reason: string;
}

/**
 * Active comp rules. Add a user here to comp their first `cap` completed
 * entities; remove them (or drop the cap) when the eval converts to paid.
 */
export const COMP_EVAL_RULES: CompRule[] = [
  {
    userId: 'cec32d38-7484-4da2-ad41-1cd25ecccaad', // shaurya.kabra@biz2credit.com
    cap: 10,
    reason: 'Biz2Credit Tax Guard head-to-head eval (Matt 2026-07-23). Converts to paid high-volume at $39.98 once comfortable.',
  },
];

/**
 * Resolve the comp rules into a concrete Set of entity ids to exclude from
 * billing: for each comped user, their earliest `cap` COMPLETED entities
 * (across all time, so the cap is a lifetime eval allowance, not per-period).
 *
 * Best-effort: on any query error it returns an empty set, so a lookup failure
 * can never accidentally suppress a real charge — it fails toward billing.
 */
export async function getCompedEntityIds(admin: SupabaseClient): Promise<Set<string>> {
  const comped = new Set<string>();
  if (COMP_EVAL_RULES.length === 0) return comped;

  for (const rule of COMP_EVAL_RULES) {
    if (rule.cap <= 0) continue;
    try {
      // Entities on requests this user placed, completed, oldest first. The
      // join keeps it scoped to the user regardless of which client they're on.
      const { data, error } = await admin
        .from('request_entities')
        .select('id, completed_at, status, requests!inner(requested_by)')
        .eq('requests.requested_by', rule.userId)
        .eq('status', 'completed')
        .order('completed_at', { ascending: true })
        .limit(rule.cap) as { data: any[] | null; error: any };
      if (error) {
        console.error(`[comp-eval] lookup failed for ${rule.userId} (billing proceeds):`, error.message);
        continue;
      }
      for (const e of data || []) comped.add(e.id);
    } catch (e: any) {
      console.error(`[comp-eval] threw for ${rule.userId} (billing proceeds):`, e?.message || e);
    }
  }
  return comped;
}
