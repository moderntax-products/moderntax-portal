/**
 * Weekly feature digest — what changed in ordering, sent to processors who
 * can actually use it.
 *
 * Matt, 2026-07-22: "a weekly feature update email to summarize all the new
 * ordering features."
 *
 * TWO DESIGN CHOICES WORTH KNOWING
 *
 * 1. The changelog is a dated LOG, not a hardcoded blast. Each run sends only
 *    entries newer than the recipient's last digest, so this keeps working
 *    every week without someone rewriting the copy — and nobody is told twice
 *    about the same feature. Add an entry when you ship; that's the whole
 *    maintenance burden.
 *
 * 2. Audience is gated on ACTUALLY BEING ABLE TO ORDER. Same rule as the
 *    activation track: on 2026-07-22 five people who looked disinterested
 *    turned out to be blocked by our own defects. Announcing features to
 *    someone who gets a 400 or 402 when they try to use them is worse than
 *    silence. Blocked users are returned separately as a bug queue.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { checkOrderGate } from '@/lib/order-gate';

/** audit_log action + dedupe key. */
export const DIGEST_ACTION = 'weekly_feature_digest';
/** Never send two digests inside this window. */
export const DIGEST_COOLDOWN_DAYS = 6;
/** Don't look further back than this for a first-time recipient. */
export const MAX_LOOKBACK_DAYS = 45;
export const MAX_SENDS_PER_RUN = 150;

/** Never contact — Matt's explicit list (2026-07-21). */
export const DO_NOT_SEND = new Set([
  'dcolvin@newitymarket.com',
  'denise.zboralske@statewidecdc.com',
  'zeinab@statewidecdc.com',
  'rventurella@enterprisebank.com',
]);

export interface FeatureEntry {
  /** ISO date the feature shipped. Drives which digest it lands in. */
  date: string;
  title: string;
  /** One or two plain sentences. Written for a loan processor, not an engineer. */
  body: string;
}

/**
 * THE CHANGELOG. Newest first. Add an entry when an ordering-facing feature
 * ships; everything else is automatic.
 *
 * Write for the person doing the work: what they can now do that they
 * couldn't, in their words. No version numbers, no internal names.
 */
export const FEATURE_LOG: FeatureEntry[] = [
  {
    date: '2026-07-22',
    title: "You no longer need the signed 8821 to place an order",
    body: "Enter the taxpayer's details and submit with no file attached. The order is created immediately and a pre-filled Form 8821 is emailed to you to collect the signature with. Previously the submit button stayed greyed out until you attached a signed form, which left you with nowhere to go if you didn't have one yet.",
  },
  {
    date: '2026-07-22',
    title: 'Email a signed 8821 and it files itself',
    body: "Send the signed copy to intake@in.moderntax.io with the loan number in the subject line and it attaches to the right order automatically — no logging in, no re-keying.",
  },
  {
    date: '2026-07-22',
    title: 'Uploaded the wrong file? Replace it yourself',
    body: 'On the order page, under "Signed 8821 on file", there is now a "Wrong file? Replace the 8821" link. The order keeps its place in line and the specialist working it is notified to use the new copy.',
  },
  {
    date: '2026-07-22',
    title: 'Large scanned 8821s upload properly',
    body: 'Scanned forms above about 4 MB were failing with a confusing error. They now upload directly and reliably at any size up to 50 MB.',
  },
  {
    date: '2026-07-22',
    title: 'The taxpayer email is now optional',
    body: "If you'd rather not share a borrower's email address, leave the field blank. Nothing about the order requires it — you remain the contact for everything.",
  },
  {
    date: '2026-07-17',
    title: 'Entity verification is included free on every order',
    body: 'We confirm the IRS filing requirements before pulling income transcripts, which prevents blank results from a wrong form type. This used to be a paid add-on; it now runs on every order at no charge.',
  },
];

export interface DigestTarget {
  id: string;
  email: string;
  full_name: string | null;
  client_name: string | null;
  /** Entries this person hasn't been told about yet. */
  entries: FeatureEntry[];
  firstTime: boolean;
}

export interface DigestBlocked {
  email: string;
  client_name: string | null;
  reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

export function isInternalOrDemo(email: string, fullName?: string | null): boolean {
  const e = (email || '').toLowerCase();
  const local = e.split('@')[0] || '';
  return (
    e.endsWith('@moderntax.io') ||
    e.endsWith('@getclearfirm.com') ||
    local.includes('+') ||
    /(^|[.\-_+])demo([.\-_+]|@)/.test(e) ||
    /\bdemo\b/i.test(fullName || '')
  );
}

/**
 * Who should get this week's digest, and what should be in theirs.
 *
 * "Active" = approved, can order right now, and has placed at least one order.
 * Never-ordered users are the activation track's job — a feature digest to
 * someone who has never used the product reads as noise.
 */
export async function findDigestTargets(
  admin: SupabaseClient,
): Promise<{ targets: DigestTarget[]; blocked: DigestBlocked[]; skipped: number }> {
  const targets: DigestTarget[] = [];
  const blocked: DigestBlocked[] = [];
  let skipped = 0;

  const { data: profs } = await admin
    .from('profiles')
    .select('id, email, full_name, role, approval_status, client_id, nudges_paused, clients(name)')
    .in('role', ['processor', 'manager'])
    .eq('approval_status', 'approved') as { data: any[] | null };
  if (!profs?.length) return { targets, blocked, skipped };

  const { data: reqs } = await admin
    .from('requests').select('requested_by') as { data: any[] | null };
  const orderCount = new Map<string, number>();
  for (const r of reqs || []) {
    if (r.requested_by) orderCount.set(r.requested_by, (orderCount.get(r.requested_by) || 0) + 1);
  }

  // Last digest per user, so each person only hears what's new to them.
  const { data: sent } = await admin
    .from('audit_log')
    .select('organization_id, created_at')
    .eq('action', DIGEST_ACTION)
    .gte('created_at', daysAgo(MAX_LOOKBACK_DAYS)) as { data: any[] | null };
  const lastDigest = new Map<string, string>();
  for (const s of sent || []) {
    if (!s.organization_id) continue;
    const prev = lastDigest.get(s.organization_id);
    if (!prev || s.created_at > prev) lastDigest.set(s.organization_id, s.created_at);
  }

  const gateCache = new Map<string, { allowed: boolean; reason?: string; status?: number }>();
  async function gateFor(clientId: string) {
    const hit = gateCache.get(clientId);
    if (hit) return hit;
    let val;
    try {
      const g = await checkOrderGate(admin, clientId);
      val = { allowed: g.allowed, reason: g.reason, status: g.status };
    } catch (e: any) {
      val = { allowed: false, reason: `gate threw: ${e?.message || e}` };
    }
    gateCache.set(clientId, val);
    return val;
  }

  const cutoffFloor = daysAgo(MAX_LOOKBACK_DAYS);

  for (const p of profs) {
    if (!p.email || p.nudges_paused) { skipped++; continue; }
    if (DO_NOT_SEND.has(p.email.toLowerCase())) { skipped++; continue; }
    if (isInternalOrDemo(p.email, p.full_name)) { skipped++; continue; }
    // Feature news is for people who use the product.
    if (!(orderCount.get(p.id) || 0)) { skipped++; continue; }

    const clientName = p.clients?.name ?? null;
    if (!p.client_id) {
      blocked.push({ email: p.email, client_name: clientName, reason: 'profile has no client_id — cannot order' });
      continue;
    }
    const g = await gateFor(p.client_id);
    if (!g.allowed) {
      blocked.push({ email: p.email, client_name: clientName, reason: `order gate ${g.status || 402} ${g.reason || 'blocked'}` });
      continue;
    }

    const since = lastDigest.get(p.id);
    const firstTime = !since;
    const floor = since && since > cutoffFloor ? since : cutoffFloor;
    const entries = FEATURE_LOG.filter((f) => new Date(f.date).toISOString() > floor);
    if (entries.length === 0) { skipped++; continue; }   // nothing new for them

    targets.push({
      id: p.id,
      email: p.email,
      full_name: p.full_name,
      client_name: clientName,
      entries,
      firstTime,
    });
  }

  return { targets, blocked, skipped };
}

export async function alreadyDigested(admin: SupabaseClient, days: number): Promise<Set<string>> {
  const { data, error } = await admin
    .from('audit_log')
    .select('organization_id')
    .eq('action', DIGEST_ACTION)
    .gte('created_at', daysAgo(days)) as { data: any[] | null; error: any };
  // Fail CLOSED. A silently-empty dedupe set is how the order-growth cron
  // nearly re-sent to everyone on every run (fixed 2026-07-22).
  if (error) throw new Error(`digest dedupe query failed: ${error.message}`);
  return new Set((data || []).map((r) => r.organization_id).filter(Boolean));
}

// ───────────────────────────────────────────────────────────────────────────
// Sender — plain text from Matt's address.
//
// Jeff Jaddoe (Cal Statewide) told us on 2026-07-22: "I thought your emails
// were spam." Branded HTML from notifications@ is what made a real message
// look like bulk mail. Product news from the founder should look like the
// founder wrote it.
// ───────────────────────────────────────────────────────────────────────────

import sgMail from '@sendgrid/mail';

const sendGridApiKey = process.env.SENDGRID_API_KEY;
if (sendGridApiKey) sgMail.setApiKey(sendGridApiKey);
const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

export const firstName = (full: string | null | undefined): string =>
  (full || '').trim().split(/\s+/)[0] || 'there';

export function buildDigestText(t: DigestTarget): string {
  const name = firstName(t.full_name);
  const lead = t.firstTime
    ? `A few things changed in how ordering works — here's what's new since you last placed an order.`
    : `Quick round-up of what changed in ordering this week.`;

  const items = t.entries
    .map((e, i) => `${i + 1}. ${e.title}\n   ${e.body}`)
    .join('\n\n');

  return `Hi ${name},

${lead}

${items}

Place an order: ${appUrl}/new

If any of this doesn't work the way it reads, reply and tell me — most of these came from processors writing in about something that was broken.

Matt Parker
ModernTax
matt@moderntax.io

(Reply "pause" if you'd rather not get these.)`;
}

export async function sendFeatureDigest(t: DigestTarget): Promise<boolean> {
  if (!sendGridApiKey) {
    console.warn('[feature-digest] SENDGRID_API_KEY not set — skipping send');
    return false;
  }
  const count = t.entries.length;
  const subject = count === 1
    ? `ModernTax: ${t.entries[0].title.toLowerCase().replace(/^you /, 'you ')}`
    : `What's new in ordering (${count} updates)`;
  try {
    await sgMail.send({
      to: t.email,
      from: { email: 'matt@moderntax.io', name: 'Matt Parker' },
      replyTo: 'matt@moderntax.io',
      subject,
      text: buildDigestText(t),
    });
    return true;
  } catch (e: any) {
    console.error(`[feature-digest] send failed to ${t.email}:`, e?.message || e);
    return false;
  }
}
