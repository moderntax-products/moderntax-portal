/**
 * First-order activation — the never-activated cohort.
 *
 * Complements lib/order-growth.ts, which deliberately skips anyone who has
 * never ordered ("Track A's job"). Track A of the reengagement sequence is
 * shadow-only and has never sent, so in practice these people got nothing at
 * all. As of 2026-07-22 that was 20 approved users with zero orders against a
 * 50/day target we were hitting at ~1.6/day.
 *
 * WHY THIS ENGINE VERIFIES BEFORE IT SENDS
 * ----------------------------------------
 * The assumption behind "they signed up and lost interest" turned out to be
 * mostly wrong. Investigating three of them on 2026-07-21/22 found:
 *
 *   - Joaquin Lavera (3rdst) and Stephen Barber (Southern Grace) had
 *     profiles with client_id = NULL, so every intake route rejected them
 *     with 400 "No client associated" before doing anything.
 *   - Elena Perceleanu (BFC) hit 402 card_required on an account we opened
 *     ourselves, after being told she could order.
 *   - Robin Kim, an ACTIVE processor, could not upload a signed 8821 at all
 *     because scanned PDFs exceeded Vercel's request-body cap.
 *
 * Every one of those is a wall we built. Emailing "place your first order!"
 * to someone who then hits that wall is worse than staying silent: it burns
 * the one moment of intent we get, and it teaches them the product is broken.
 *
 * So this engine runs checkOrderGate() against each candidate BEFORE it sends
 * and drops anyone who cannot actually complete the action we're asking for.
 * Blocked users are reported separately so the blocker gets fixed rather than
 * silently swallowed. That report is the point — a growing blocked list is a
 * product bug queue, not an audience to email harder.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { checkOrderGate } from '@/lib/order-gate';

/** Send at most one activation touch per user per this many days. */
export const ACTIVATION_COOLDOWN_DAYS = 21;
/** Skip anyone reengagement or order-growth touched this recently. */
export const RECENT_TOUCH_DAYS = 10;
/** Don't nudge an account that only signed up hours ago — let them land first. */
export const MIN_ACCOUNT_AGE_DAYS = 2;
/** Safety cap per run. */
export const MAX_SENDS_PER_RUN = 60;

/** audit_log action, also the dedupe key. */
export const ACTIVATION_ACTION = 'first_order_activation';

/**
 * Never contact. Matt's explicit do-not-send list (2026-07-21), kept in code
 * so it survives a cron running with nobody watching.
 */
export const DO_NOT_SEND = new Set([
  'dcolvin@newitymarket.com',
  'denise.zboralske@statewidecdc.com',
  'zeinab@statewidecdc.com',
  'rventurella@enterprisebank.com',
]);

/**
 * Internal/demo accounts. These exist for sales demos and screenshots; a
 * lifecycle email to one of them is at best noise and at worst embarrassing
 * in front of a prospect.
 */
export function isInternalOrDemo(email: string, fullName?: string | null): boolean {
  const e = (email || '').toLowerCase();
  const local = e.split('@')[0] || '';
  return (
    e.endsWith('@moderntax.io') ||
    // ClearFirm is a SEPARATE entity that happens to be a ModernTax customer.
    // Its logins are Matt's own and are used for API/integration testing —
    // they are never a marketing audience, and mixing the two brands in an
    // outbound email is exactly the commingling we don't do.
    e.endsWith('@getclearfirm.com') ||
    // Plus-addressed aliases (matt+1@…) are test accounts by convention.
    local.includes('+') ||
    /(^|[.\-_+])demo([.\-_+]|@)/.test(e) ||
    /\bdemo\b/i.test(fullName || '')
  );
}

/**
 * Disposable/throwaway signup addresses. `fifiv32700@mypethealh.com` reached
 * us on a misspelled domain whose MX points at a disposable-mail provider —
 * there is no company behind it to activate.
 */
const DISPOSABLE_DOMAINS = new Set(['mypethealh.com']);
export function looksDisposable(email: string): boolean {
  const domain = (email.split('@')[1] || '').toLowerCase();
  if (DISPOSABLE_DOMAINS.has(domain)) return true;
  // Random-looking local parts (e.g. "fifiv32700") on free-ish domains.
  const local = (email.split('@')[0] || '').toLowerCase();
  return /^[a-z]{4,8}\d{4,}$/.test(local);
}

export interface ActivationTarget {
  id: string;
  email: string;
  full_name: string | null;
  client_id: string;
  client_name: string | null;
  role: string;
  daysSinceSignup: number;
  /** How many colleagues on the same client have ordered — powers the copy. */
  teammateOrders: number;
  teammateName: string | null;
}

export interface BlockedTarget {
  email: string;
  full_name: string | null;
  client_name: string | null;
  reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

/**
 * Approved users with ZERO orders who can actually place one right now.
 *
 * Returns both the sendable audience and the blocked list. The caller should
 * surface `blocked` — those are product defects, not disinterested users.
 */
export async function findActivationTargets(
  admin: SupabaseClient,
): Promise<{ targets: ActivationTarget[]; blocked: BlockedTarget[]; skipped: number }> {
  const targets: ActivationTarget[] = [];
  const blocked: BlockedTarget[] = [];
  let skipped = 0;

  const { data: profs } = await admin
    .from('profiles')
    .select('id, email, full_name, role, approval_status, client_id, created_at, nudges_paused, clients(name)')
    .in('role', ['processor', 'manager'])
    .eq('approval_status', 'approved') as { data: any[] | null };

  if (!profs?.length) return { targets, blocked, skipped };

  // Lifetime order counts, by user and by client.
  const { data: reqs } = await admin
    .from('requests')
    .select('requested_by, client_id, created_at') as { data: any[] | null };

  const byUser = new Map<string, number>();
  const byClient = new Map<string, number>();
  for (const r of reqs || []) {
    if (r.requested_by) byUser.set(r.requested_by, (byUser.get(r.requested_by) || 0) + 1);
    if (r.client_id) byClient.set(r.client_id, (byClient.get(r.client_id) || 0) + 1);
  }

  // Name a colleague who is already ordering — "your team is using this"
  // outperforms "you signed up once", and it's true.
  const topByClient = new Map<string, { name: string; count: number }>();
  for (const p of profs) {
    const n = byUser.get(p.id) || 0;
    if (!n || !p.client_id) continue;
    const cur = topByClient.get(p.client_id);
    if (!cur || n > cur.count) {
      topByClient.set(p.client_id, { name: (p.full_name || '').split(/\s+/)[0] || 'a colleague', count: n });
    }
  }

  const now = Date.now();

  for (const p of profs) {
    if (byUser.get(p.id)) continue;                      // already activated
    if (!p.email) { skipped++; continue; }
    if (p.nudges_paused) { skipped++; continue; }
    if (DO_NOT_SEND.has(p.email.toLowerCase())) { skipped++; continue; }
    if (isInternalOrDemo(p.email, p.full_name)) { skipped++; continue; }
    if (looksDisposable(p.email)) { skipped++; continue; }

    const ageDays = Math.floor((now - +new Date(p.created_at)) / DAY_MS);
    if (ageDays < MIN_ACCOUNT_AGE_DAYS) { skipped++; continue; }

    const clientName = p.clients?.name ?? null;

    // A profile with no client cannot order at all — that's a defect to fix,
    // not an audience to email.
    if (!p.client_id) {
      blocked.push({
        email: p.email,
        full_name: p.full_name,
        client_name: clientName,
        reason: 'profile has no client_id — every intake route rejects with 400',
      });
      continue;
    }

    // The pre-flight. Never invite someone through a door we've locked.
    let gate;
    try {
      gate = await checkOrderGate(admin, p.client_id);
    } catch (e: any) {
      blocked.push({
        email: p.email,
        full_name: p.full_name,
        client_name: clientName,
        reason: `order gate threw: ${e?.message || e}`,
      });
      continue;
    }

    if (!gate.allowed) {
      blocked.push({
        email: p.email,
        full_name: p.full_name,
        client_name: clientName,
        reason: `order gate ${gate.status || 402} ${gate.reason || 'blocked'}`,
      });
      continue;
    }

    const top = topByClient.get(p.client_id);
    targets.push({
      id: p.id,
      email: p.email,
      full_name: p.full_name,
      client_id: p.client_id,
      client_name: clientName,
      role: p.role,
      daysSinceSignup: ageDays,
      teammateOrders: byClient.get(p.client_id) || 0,
      teammateName: top?.name ?? null,
    });
  }

  return { targets, blocked, skipped };
}

/**
 * User ids touched by any of `actions` within `days` (dedupe via audit_log).
 *
 * Selects `organization_id`, NOT `user_id` — logAuditEvent maps userId onto
 * the repurposed `organization_id` column, and there is no `user_id` column
 * on audit_log at all. Getting this wrong returns `data: null` on a
 * swallowed PostgREST error, which reads as "nobody has been contacted" and
 * disables suppression entirely. See the note on alreadySent() in
 * lib/order-growth.ts — that exact bug shipped live on 2026-07-22.
 */
export async function recentlyTouched(
  admin: SupabaseClient,
  actions: string[],
  days: number,
): Promise<Set<string>> {
  const { data, error } = await admin
    .from('audit_log')
    .select('organization_id, action')
    .in('action', actions)
    .gte('created_at', daysAgo(days)) as { data: any[] | null; error: any };
  if (error) {
    // Never fall through to "send to everyone" because a query broke.
    console.error('[first-order-activation] recentlyTouched query failed — dedupe unavailable:', error.message);
    throw new Error(`dedupe query failed: ${error.message}`);
  }
  return new Set((data || []).map((r) => r.organization_id).filter(Boolean));
}

/**
 * Reengagement rows logged in SHADOW mode must not suppress a real send —
 * shadow means nothing was delivered. Same bug fixed in order-growth (#75).
 */
export async function recentlyReengaged(admin: SupabaseClient): Promise<Set<string>> {
  try {
    const { data } = await admin
      .from('reengagement_log')
      .select('user_id, sent_at, shadow')
      .eq('shadow', false)
      .gte('sent_at', daysAgo(RECENT_TOUCH_DAYS)) as { data: any[] | null };
    return new Set((data || []).map((r) => r.user_id).filter(Boolean));
  } catch {
    return new Set();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Sender — self-contained, mirroring lib/order-growth.ts.
// ───────────────────────────────────────────────────────────────────────────

import sgMail from '@sendgrid/mail';

const sendGridApiKey = process.env.SENDGRID_API_KEY;
if (sendGridApiKey) sgMail.setApiKey(sendGridApiKey);
const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io';
const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

const esc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const firstName = (full: string | null | undefined): string =>
  (full || '').trim().split(/\s+/)[0] || 'there';

function shell(title: string, body: string, ctaLabel: string, ctaUrl: string): string {
  return `
<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#13213e;">
  <div style="background:linear-gradient(135deg,#0A1929,#102A43);padding:22px 24px;border-radius:10px 10px 0 0;">
    <div style="color:#fff;font-size:17px;font-weight:700;">${esc(title)}</div>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:24px;background:#fff;line-height:1.6;font-size:15px;">
    ${body}
    <div style="margin:26px 0 6px;">
      <a href="${ctaUrl}" style="display:inline-block;background:#00C48C;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px;">${esc(ctaLabel)}</a>
    </div>
    <p style="font-size:12px;color:#8b93a7;margin-top:22px;">
      You're getting this because you have a ModernTax account.
      Reply "pause" and I'll stop these.
    </p>
  </div>
</div>`.trim();
}

async function send(to: string, subject: string, html: string, text: string): Promise<boolean> {
  if (!sendGridApiKey) {
    console.warn('[first-order-activation] SENDGRID_API_KEY not set — skipping send');
    return false;
  }
  try {
    await sgMail.send({
      to,
      from: { email: fromEmail, name: 'Matt at ModernTax' },
      replyTo: 'matt@moderntax.io',
      subject,
      html,
      text,
    });
    return true;
  } catch (e: any) {
    console.error(`[first-order-activation] send failed to ${to}:`, e?.message || e);
    return false;
  }
}

/**
 * The activation touch.
 *
 * Two voices. When colleagues on the same client are already ordering, lead
 * with that — it's the strongest true thing we can say, and these people sit
 * next to someone who can vouch for it. Otherwise keep it plain.
 *
 * No discount, no urgency, no "just checking in". The ask is one order.
 */
export async function sendFirstOrderNudge(t: ActivationTarget): Promise<boolean> {
  const name = firstName(t.full_name);
  const team = t.client_name;
  const hasTeam = t.teammateOrders > 0 && !!t.teammateName;

  const subject = hasTeam
    ? `${name}, your team's pulling transcripts — want to try one?`
    : `${name}, want to pull your first transcript?`;

  const lead = hasTeam
    ? `<p>${esc(t.teammateName!)} and the team at <strong>${esc(team || 'your office')}</strong>
       have been running transcript pulls through ModernTax, but nothing's come through under
       your login yet. If that's just because you haven't had a reason to try it, here's what
       it looks like.</p>`
    : `<p>You set up a ModernTax account but haven't placed an order yet. No pressure at all
       &mdash; but if a file has been waiting on IRS transcripts, this is the short version of
       how it works.</p>`;

  const body = `
<p>Hi ${esc(name)},</p>
${lead}
<ul style="margin:10px 0 0;padding-left:20px;">
  <li style="margin-bottom:8px;">Enter the taxpayer once &mdash; a <strong>pre-filled Form 8821</strong>
      downloads and lands in your inbox. No blank templates.</li>
  <li style="margin-bottom:8px;">Don't have it signed yet? Submit the order anyway. We'll send you
      the form and hold the order until the signature comes back.</li>
  <li style="margin-bottom:8px;">Email the signed copy to <strong>intake@in.moderntax.io</strong>
      with the loan number in the subject and it files itself.</li>
  <li>Entity verification is included free, and you're never billed for a rejected pull.</li>
</ul>
<p style="margin-top:14px;">Most orders come back within 24 hours.</p>
<p style="font-size:14px;color:#4b5563;">If something didn't work when you tried before, tell me
what happened &mdash; a few people hit bugs on our end recently and I'd rather hear about it than
assume you weren't interested.</p>`;

  const text = `Hi ${name},

${hasTeam
  ? `${t.teammateName} and the team at ${team || 'your office'} have been running transcript pulls through ModernTax, but nothing's come through under your login yet.`
  : `You set up a ModernTax account but haven't placed an order yet.`}

- Enter the taxpayer once — a pre-filled Form 8821 downloads and lands in your inbox.
- Don't have it signed yet? Submit the order anyway; we'll send the form and hold the order.
- Email the signed copy to intake@in.moderntax.io with the loan number in the subject and it files itself.
- Entity verification is free, and you're never billed for a rejected pull.

Most orders come back within 24 hours.

If something didn't work when you tried before, tell me what happened — a few people hit bugs on our end recently and I'd rather hear about it than assume you weren't interested.

Place an order: ${appUrl}/new

— Matt`;

  return send(t.email, subject, shell(
    hasTeam ? 'Your team is already pulling transcripts' : 'Your first transcript pull',
    body,
    'Place your first order',
    `${appUrl}/new`,
  ), text);
}
