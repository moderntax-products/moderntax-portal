/**
 * Order-growth engine — the daily-order-volume lever.
 *
 * Goal (Matt, 2026-07): refocus the portal on DAILY order growth, targeting
 * ~50 orders/day. Two gentle touches, both aimed at "make your next order":
 *
 *   1. WEEKLY LAPSED — processors with zero orders in the last 7 days get one
 *      light nudge per week. Recurring, unlike the one-shot lifecycle sequence.
 *   2. NEXT-ORDER — when an order completes, the processor who placed it gets a
 *      "that one's done, what's next?" nudge. This is the compounding lever:
 *      every completion becomes an invitation to reorder.
 *
 * RELATIONSHIP TO reengagement-sequence (already live): that is a ONE-SHOT
 * onboarding/lapsed lifecycle (Track A d3-16 for never-activated, Track B
 * d30-50 for long-dormant). This engine is the RECURRING weekly cadence at a
 * 7-day threshold. They overlap for anyone 30+ days dormant, so we suppress a
 * processor who got a reengagement step recently (see RECENT_REENGAGEMENT_DAYS)
 * — nobody should ever receive both in the same week.
 *
 * Dedupe/state lives in audit_log (same trick trial-welcome-drip uses) so this
 * ships with no migration.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** The north-star this engine exists to move. */
export const DAILY_ORDER_TARGET = 50;

/** No orders in this many days → eligible for the weekly nudge. */
export const LAPSED_DAYS = 7;
/** Send the weekly nudge at most once per this many days, per processor. */
export const WEEKLY_COOLDOWN_DAYS = 7;
/** Look back this far for freshly-completed orders. */
export const COMPLETION_LOOKBACK_HOURS = 26; // 24h + slack for cron drift
/** Skip anyone the reengagement sequence touched this recently. */
export const RECENT_REENGAGEMENT_DAYS = 10;
/** Safety cap per run so a bad query can never blast the whole book. */
export const MAX_SENDS_PER_RUN = 120;

export interface ProcessorTarget {
  id: string;
  email: string;
  full_name: string | null;
  client_id: string;
  client_name?: string | null;
  /** Total lifetime orders — used to pick voice (first-timer vs regular). */
  orderCount: number;
  daysSinceLastOrder: number | null;
}

export interface CompletionTarget extends ProcessorTarget {
  request_id: string;
  loan_number: string | null;
  entity_count: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

/** Eligible = approved processor, has a client + email, not paused. */
function isEligible(p: any): boolean {
  return !!(
    p.client_id &&
    p.email &&
    (p.approval_status === 'approved' || p.approval_status == null) &&
    !p.nudges_paused
  );
}

/**
 * Processors with ZERO orders in the last `days` days (but who have ordered at
 * least once — a never-activated processor belongs to reengagement Track A,
 * not here; nudging them to "order again" would be nonsense).
 */
export async function findLapsedProcessors(
  admin: SupabaseClient,
  days: number = LAPSED_DAYS,
): Promise<ProcessorTarget[]> {
  const { data: profs } = await admin
    .from('profiles')
    .select('id, email, full_name, client_id, role, approval_status, nudges_paused, clients(name)')
    .eq('role', 'processor') as { data: any[] | null };
  const candidates = (profs || []).filter(isEligible);
  if (!candidates.length) return [];

  const ids = candidates.map((p) => p.id);
  const { data: reqs } = await admin
    .from('requests')
    .select('requested_by, created_at')
    .in('requested_by', ids) as { data: any[] | null };

  const byUser = new Map<string, { count: number; last: number }>();
  for (const r of reqs || []) {
    const t = new Date(r.created_at).getTime();
    const cur = byUser.get(r.requested_by) || { count: 0, last: 0 };
    byUser.set(r.requested_by, { count: cur.count + 1, last: Math.max(cur.last, t) });
  }

  const cutoff = Date.now() - days * DAY_MS;
  const out: ProcessorTarget[] = [];
  for (const p of candidates) {
    const info = byUser.get(p.id);
    if (!info || info.count === 0) continue;          // never ordered → Track A's job
    if (info.last >= cutoff) continue;                 // ordered recently → not lapsed
    out.push({
      id: p.id,
      email: p.email,
      full_name: p.full_name,
      client_id: p.client_id,
      client_name: p.clients?.name ?? null,
      orderCount: info.count,
      daysSinceLastOrder: Math.floor((Date.now() - info.last) / DAY_MS),
    });
  }
  return out;
}

/** Orders that completed in the lookback window, with who placed them. */
export async function findRecentCompletions(
  admin: SupabaseClient,
  hours: number = COMPLETION_LOOKBACK_HOURS,
): Promise<CompletionTarget[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { data: reqs } = await admin
    .from('requests')
    .select('id, requested_by, client_id, loan_number, completed_at, status, request_entities(id)')
    .eq('status', 'completed')
    .gte('completed_at', since) as { data: any[] | null };
  if (!reqs?.length) return [];

  const userIds = [...new Set(reqs.map((r) => r.requested_by).filter(Boolean))];
  if (!userIds.length) return [];
  const { data: profs } = await admin
    .from('profiles')
    .select('id, email, full_name, client_id, role, approval_status, nudges_paused, clients(name)')
    .in('id', userIds) as { data: any[] | null };
  const profById = new Map((profs || []).filter(isEligible).map((p) => [p.id, p]));

  // Lifetime order counts, so the copy can differ for a 2nd order vs a 40th.
  const { data: allReqs } = await admin
    .from('requests').select('requested_by').in('requested_by', userIds) as { data: any[] | null };
  const counts = new Map<string, number>();
  for (const r of allReqs || []) counts.set(r.requested_by, (counts.get(r.requested_by) || 0) + 1);

  const out: CompletionTarget[] = [];
  for (const r of reqs) {
    const p = profById.get(r.requested_by);
    if (!p) continue;
    out.push({
      id: p.id,
      email: p.email,
      full_name: p.full_name,
      client_id: p.client_id,
      client_name: p.clients?.name ?? null,
      orderCount: counts.get(p.id) || 1,
      daysSinceLastOrder: 0,
      request_id: r.id,
      loan_number: r.loan_number ?? null,
      entity_count: Array.isArray(r.request_entities) ? r.request_entities.length : 0,
    });
  }
  return out;
}

/**
 * Suppression: user ids that ACTUALLY received a reengagement step recently.
 *
 * Must filter shadow=false. The reengagement cron logs a row for every step it
 * *would* send while REENGAGEMENT_AUTOSEND is off — as of 2026-07-21 that table
 * held 29 rows, all shadow, zero real sends. Counting those as "already
 * contacted" would silently suppress genuine order-growth emails to processors
 * who were never actually emailed, and it would compound every day the shadow
 * cron runs. Shadow means nothing left the building, so it must not suppress.
 *
 * Reading the log is best-effort — if the table isn't there we simply don't
 * suppress (and the per-user cooldown still prevents spam).
 */
export async function recentlyReengaged(admin: SupabaseClient): Promise<Set<string>> {
  try {
    const { data } = await admin
      .from('reengagement_log')
      .select('user_id, sent_at, shadow')
      .eq('shadow', false)
      .gte('sent_at', daysAgo(RECENT_REENGAGEMENT_DAYS)) as { data: any[] | null };
    return new Set((data || []).map((r) => r.user_id).filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * User ids already sent `action` within `days` (dedupe via audit_log).
 *
 * COLUMN NAMES MATTER HERE. audit_log has no `user_id` or `resource_id`
 * column — logAuditEvent maps its interface onto the real table as
 * `userId → organization_id` (a repurposed column) and
 * `resourceId → entity_id`. Selecting the interface names made PostgREST
 * return `column audit_log.user_id does not exist`, which the destructure
 * silently swallowed as `data: null` — so this returned an EMPTY set and
 * suppressed nothing. Both the weekly cooldown and the per-request dedupe
 * were inert, meaning a processor could be nudged on every single run.
 * Caught 2026-07-22, the day autosend first went live.
 */
export async function alreadySent(
  admin: SupabaseClient,
  action: string,
  days: number,
): Promise<Set<string>> {
  const { data, error } = await admin
    .from('audit_log')
    .select('organization_id, entity_id')
    .eq('action', action)
    .gte('created_at', daysAgo(days)) as { data: any[] | null; error: any };
  if (error) {
    // Fail CLOSED-ish: a dedupe query that errors must be loud. Silently
    // returning an empty set is what caused the original bug.
    console.error(`[order-growth] alreadySent(${action}) query failed — dedupe unavailable:`, error.message);
    throw new Error(`dedupe query failed for ${action}: ${error.message}`);
  }
  const s = new Set<string>();
  for (const r of data || []) {
    if (r.organization_id) s.add(r.organization_id); // userId
    if (r.entity_id) s.add(r.entity_id);             // request-scoped dedupe
  }
  return s;
}

export const firstName = (full: string | null | undefined): string =>
  (full || '').trim().split(/\s+/)[0] || 'there';

// ───────────────────────────────────────────────────────────────────────────
// Senders — self-contained (createEmailTemplate isn't exported from
// lib/sendgrid.ts), mirroring the lib/compliance-drip.ts pattern.
// ───────────────────────────────────────────────────────────────────────────

import sgMail from '@sendgrid/mail';

const sendGridApiKey = process.env.SENDGRID_API_KEY;
if (sendGridApiKey) sgMail.setApiKey(sendGridApiKey);
const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';
const SOCIAL_TEXT = 'More from ModernTax: Substack https://moderntax.substack.com · LinkedIn https://www.linkedin.com/company/moderntax';

// Plain text from Matt's address — founder voice. Branded HTML from
// notifications@ read as bulk mail (Jeff Jaddoe, Cal Statewide, 2026-07-22),
// so these now match the first-order / feature-digest engines: text only.
async function send(to: string, subject: string, text: string): Promise<boolean> {
  if (!sendGridApiKey) {
    console.warn('[order-growth] SENDGRID_API_KEY not set — skipping send');
    return false;
  }
  try {
    await sgMail.send({
      to,
      from: { email: 'matt@moderntax.io', name: 'Matt Parker' },
      replyTo: 'matt@moderntax.io',
      subject,
      text,
    });
    return true;
  } catch (e: any) {
    console.error(`[order-growth] send failed to ${to}:`, e?.message || e);
    return false;
  }
}

/** WEEKLY LAPSED — gentle "nothing this week" nudge. */
export async function sendWeeklyOrderNudge(t: ProcessorTarget): Promise<boolean> {
  const name = firstName(t.full_name);
  const d = t.daysSinceLastOrder ?? LAPSED_DAYS;
  const subject = `Anything to pull this week, ${name}?`;
  const text = `Hi ${name},

Nothing came through${t.client_name ? ` from ${t.client_name}` : ''} this week — last order was ~${d} days ago. No problem if it's quiet; just making it easy if you have files waiting.

A couple of things that make it quicker than it used to be:
- Enter the taxpayer once and a pre-filled 8821 lands in your inbox — no blank templates.
- Email the signed copy to intake@in.moderntax.io with the loan number in the subject and it files itself.
- Entity verification is now included free on every order.

Most orders come back within 24 hours.

Place an order: ${appUrl}/new

${SOCIAL_TEXT}

— Matt

(Reply "pause" if you'd rather not get these.)`;
  return send(t.email, subject, text);
}

/** NEXT-ORDER — fires right after an order completes. The compounding lever. */
export async function sendNextOrderNudge(t: CompletionTarget): Promise<boolean> {
  const name = firstName(t.full_name);
  const n = t.entity_count;
  // loan_number is free-text and in practice often holds a COMPANY NAME rather
  // than a number (e.g. "Kelley Erosion Control, Inc"), which made the subject
  // read "for loan #Kelley Erosion Control, Inc". Only use the "loan #" prefix
  // when it actually looks like an identifier; otherwise name it plainly.
  const raw = (t.loan_number || '').trim();
  const looksLikeLoanNo = raw.length > 0 && raw.length <= 20 && /\d/.test(raw) && !/\s/.test(raw);
  const label = raw ? (looksLikeLoanNo ? `loan #${raw}` : raw) : '';
  const loan = label ? ` for ${label}` : '';
  const subject = label
    ? `Transcripts are in for ${label} — what's next?`
    : `Your transcripts are in — what's next?`;
  const milestone = t.orderCount <= 2
    ? `That's order #${t.orderCount} done — nice. If you've got another file in underwriting, it takes about a minute to queue up.`
    : `If you've got another file moving through underwriting, it takes about a minute to queue the next one.`;
  const text = `Hi ${name},

Your ${n > 0 ? `${n} ${n === 1 ? 'entity' : 'entities'}` : 'transcripts'}${loan} ${n === 1 ? 'is' : 'are'} complete and posted in the portal.

${milestone}

Reminder: entity verification is free, you're never billed for a rejected pull, and the pre-filled 8821 comes straight back to your inbox.

Order the next one: ${appUrl}/new

${SOCIAL_TEXT}

— Matt

(Reply "pause" if you'd rather not get these.)`;
  return send(t.email, subject, text);
}
