/**
 * Platform Insights digest — an anonymized, network-wide snapshot emailed to
 * client-org processors & managers, especially new sign-ups and people who
 * signed up but never placed a first order.
 *
 * Matt, 2026-07-31: "engaging emails updating them on how to use the platform,
 * order transcripts, and general information that anonymizes findings across
 * our platform. Especially for new signups and folks who signed up and never
 * made an order."
 *
 * DESIGN — mirrors the weekly-feature-digest engine deliberately:
 *  - Founder-voice PLAIN TEXT from matt@moderntax.io. A processor (Jeff Jaddoe,
 *    Cal Statewide) told us branded HTML from notifications@ "looked like spam";
 *    this must read like Matt wrote it. No branded shell, no images.
 *  - AGGREGATE + ANONYMIZED ONLY. Never a client name, loan, borrower, or
 *    taxpayer detail — just network-wide counts, a median turnaround, and a
 *    clean-file rate. Test/sandbox clients are excluded so the numbers are real.
 *  - Unlike the feature digest, this DOES go to never-ordered users — they are
 *    the point. The copy is segmented: never-ordered get a 3-step "how to run
 *    your first file"; active users get the snapshot only.
 *  - SHADOW by default behind PLATFORM_INSIGHTS_AUTOSEND; dedupe + cooldown via
 *    audit_log, failing CLOSED; honors nudges_paused / "reply pause" / the
 *    shared DO_NOT_SEND list.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import sgMail from '@sendgrid/mail';
import { DO_NOT_SEND, isInternalOrDemo, firstName } from '@/lib/feature-digest';

const sendGridApiKey = process.env.SENDGRID_API_KEY;
if (sendGridApiKey) sgMail.setApiKey(sendGridApiKey);
const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

/** audit_log action + dedupe key. */
export const INSIGHTS_ACTION = 'platform_insights_digest';
/** Monthly cadence — never send two inside this window. */
export const INSIGHTS_COOLDOWN_DAYS = 25;
export const MAX_SENDS_PER_RUN = 120;

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

/** A client is test/sandbox (excluded from the network numbers) by slug/name. */
const isTestClient = (c: { slug?: string | null; name?: string | null }) =>
  /sandbox|demo|test|clearfirm-bot/i.test(`${c.slug || ''} ${c.name || ''}`);

export interface PlatformInsights {
  completedAllTime: number;
  completed30d: number;
  lenders: number;
  medianTurnaroundHours: number | null;
  within48hRate: number | null; // %
  cleanRate: number | null;     // % of summarized files with a clean tone
  cleanSampleN: number;
  formsCovered: string[];
  generatedAt: string;
}

/**
 * Compute the anonymized, network-wide numbers. Read-only. Excludes
 * test/sandbox clients so the figures are the real book of business.
 */
export async function computePlatformInsights(admin: SupabaseClient): Promise<PlatformInsights> {
  const { data: clients } = await admin.from('clients').select('id, name, slug') as {
    data: { id: string; name: string | null; slug: string | null }[] | null;
  };
  const testIds = new Set((clients || []).filter(isTestClient).map((c) => c.id));

  const { data: ents } = await admin
    .from('request_entities')
    .select('status, created_at, completed_at, form_type, gross_receipts, requests!inner(client_id)')
    .eq('status', 'completed') as { data: any[] | null };

  const real = (ents || []).filter((e) => !testIds.has(e.requests?.client_id));
  const now = Date.now();

  const completed30d = real.filter(
    (e) => e.completed_at && now - new Date(e.completed_at).getTime() < 30 * DAY_MS,
  ).length;

  const lenders = new Set(real.map((e) => e.requests?.client_id).filter(Boolean)).size;

  // Turnaround from entity created → completed, last 90 days, sane bounds.
  const turn = real
    .filter((e) => e.completed_at && e.created_at && now - new Date(e.completed_at).getTime() < 90 * DAY_MS)
    .map((e) => (new Date(e.completed_at).getTime() - new Date(e.created_at).getTime()) / 3_600_000)
    .filter((h) => h >= 0 && h < 24 * 60)
    .sort((a, b) => a - b);
  const median = turn.length ? turn[Math.floor(turn.length / 2)] : null;
  const within48 = turn.length ? Math.round((turn.filter((h) => h <= 48).length / turn.length) * 100) : null;

  // Clean-file rate from the stored processor summary tone (ok = clean).
  let summarized = 0;
  let clean = 0;
  for (const e of real) {
    const tone = (e.gross_receipts as any)?.processor_summary?.tone;
    if (tone) {
      summarized++;
      if (tone === 'ok') clean++;
    }
  }
  const cleanRate = summarized > 0 ? Math.round((clean / summarized) * 100) : null;

  const formsCovered = [...new Set(real.map((e) => e.form_type).filter(Boolean))].sort();

  return {
    completedAllTime: real.length,
    completed30d,
    lenders,
    medianTurnaroundHours: median != null ? Math.round(median) : null,
    within48hRate: within48,
    cleanRate,
    cleanSampleN: summarized,
    formsCovered,
    generatedAt: new Date().toISOString(),
  };
}

export interface InsightsRecipient {
  id: string;
  email: string;
  full_name: string | null;
  client_name: string | null;
  orderCount: number;
}

/**
 * Everyone who should get the digest: approved processors & managers with a
 * client, minus internal/demo/paused/opted-out. INCLUDES never-ordered users —
 * they are the priority audience. Returns each recipient's lifetime order count
 * so the copy can be segmented.
 */
export async function findInsightsRecipients(
  admin: SupabaseClient,
): Promise<{ recipients: InsightsRecipient[]; skipped: number }> {
  const recipients: InsightsRecipient[] = [];
  let skipped = 0;

  const { data: profs } = await admin
    .from('profiles')
    .select('id, email, full_name, role, approval_status, client_id, nudges_paused, clients(name)')
    .in('role', ['processor', 'manager'])
    .eq('approval_status', 'approved') as { data: any[] | null };
  if (!profs?.length) return { recipients, skipped };

  const { data: reqs } = await admin.from('requests').select('requested_by') as { data: any[] | null };
  const orderCount = new Map<string, number>();
  for (const r of reqs || []) {
    if (r.requested_by) orderCount.set(r.requested_by, (orderCount.get(r.requested_by) || 0) + 1);
  }

  for (const p of profs) {
    if (!p.email || p.nudges_paused) { skipped++; continue; }
    if (DO_NOT_SEND.has(p.email.toLowerCase())) { skipped++; continue; }
    if (isInternalOrDemo(p.email, p.full_name)) { skipped++; continue; }
    if (!p.client_id) { skipped++; continue; }
    recipients.push({
      id: p.id,
      email: p.email,
      full_name: p.full_name,
      client_name: p.clients?.name ?? null,
      orderCount: orderCount.get(p.id) || 0,
    });
  }
  return { recipients, skipped };
}

export async function alreadyReceived(admin: SupabaseClient, days: number): Promise<Set<string>> {
  const { data, error } = await admin
    .from('audit_log')
    .select('organization_id')
    .eq('action', INSIGHTS_ACTION)
    .gte('created_at', daysAgo(days)) as { data: any[] | null; error: any };
  // Fail CLOSED — a silently-empty dedupe set is how a nudge cron nearly
  // re-sent to its whole book (feature-digest note, 2026-07-22).
  if (error) throw new Error(`insights dedupe query failed: ${error.message}`);
  return new Set((data || []).map((r) => r.organization_id).filter(Boolean));
}

/** "1040, 1065, 1120 and 1120S" */
function fmtForms(forms: string[]): string {
  if (forms.length === 0) return 'business tax';
  if (forms.length === 1) return forms[0];
  return `${forms.slice(0, -1).join(', ')} and ${forms[forms.length - 1]}`;
}

function statsBlock(ins: PlatformInsights): string {
  const lines = [
    `• ${ins.completedAllTime.toLocaleString()} business tax files verified straight from the IRS${
      ins.completed30d ? ` (${ins.completed30d} in the last 30 days)` : ''
    }`,
    `• ${ins.lenders} SBA lending team${ins.lenders === 1 ? '' : 's'} ordering on the network`,
  ];
  if (ins.medianTurnaroundHours != null) {
    lines.push(
      `• Median turnaround ${ins.medianTurnaroundHours} hours${
        ins.within48hRate != null ? ` — ${ins.within48hRate}% delivered within two days` : ''
      }`,
    );
  }
  if (ins.cleanRate != null && ins.cleanSampleN >= 50) {
    lines.push(
      `• ${ins.cleanRate}% of verified files came back clean — no outstanding IRS balance or unfiled-return flags`,
    );
  }
  lines.push(`• Covering ${fmtForms(ins.formsCovered)} returns`);
  return lines.join('\n');
}

/** Segmented plain-text body. Never-ordered users get the how-to; others don't. */
export function buildInsightsText(r: InsightsRecipient, ins: PlatformInsights): string {
  const name = firstName(r.full_name);
  const stats = statsBlock(ins);

  if (r.orderCount === 0) {
    return `Hi ${name},

You set up your ModernTax account but haven't run your first file yet — here's a look at what the network's been doing, and how to get your first one back.

Across the ModernTax network:
${stats}

Running your first file takes about a day:
1. Enter the borrower's entity details at ${appUrl}/new — you don't need a signed form to start.
2. We auto-generate a pre-filled Form 8821 and email it to you to collect the signature.
3. Upload the signed form and the IRS transcripts land in your portal, usually the next day.

Start your first order: ${appUrl}/new

If anything's holding you up, just reply — happy to walk you through it.

More from ModernTax — latest on Substack (https://moderntax.substack.com) and LinkedIn (https://www.linkedin.com/company/moderntax).

Matt Parker
ModernTax
matt@moderntax.io

(Reply "pause" if you'd rather not get these.)`;
  }

  return `Hi ${name},

A quick anonymized snapshot of what the ModernTax network has been up to — thought you'd find it useful.

Across the network:
${stats}

Nothing to do here — just sharing the pace. Whenever you've got a file to run, it's at ${appUrl}/new.

Reply anytime with what would make this more useful.

More from ModernTax — latest on Substack (https://moderntax.substack.com) and LinkedIn (https://www.linkedin.com/company/moderntax).

Matt Parker
ModernTax
matt@moderntax.io

(Reply "pause" if you'd rather not get these.)`;
}

export async function sendInsights(r: InsightsRecipient, ins: PlatformInsights): Promise<boolean> {
  if (!sendGridApiKey) {
    console.warn('[platform-insights] SENDGRID_API_KEY not set — skipping send');
    return false;
  }
  // Punchier, live-data subjects (Matt 2026-07-31). Never-ordered leads with the
  // speed promise; active users get a concrete, always-fresh network number.
  const subject =
    r.orderCount === 0
      ? 'Your first IRS transcripts are about a day away'
      : `${ins.completedAllTime.toLocaleString()} files verified across the ModernTax network`;
  try {
    await sgMail.send({
      to: r.email,
      from: { email: 'matt@moderntax.io', name: 'Matt Parker' },
      replyTo: 'matt@moderntax.io',
      subject,
      text: buildInsightsText(r, ins),
    });
    return true;
  } catch (e: any) {
    console.error(`[platform-insights] send failed to ${r.email}:`, e?.message || e);
    return false;
  }
}
