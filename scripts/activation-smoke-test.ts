/**
 * Activation smoke test — does the FIRST-ORDER funnel actually work?
 *
 * The existing daily-smoke-test.mjs proves endpoints return non-500. It does
 * NOT prove a newly-provisioned customer can place and complete a first order,
 * so it caught none of this week's leaks: Robin's 413, Carla's un-replaceable
 * 8821, Elena's orphaned form, or the systemic "approved but 402-blocked" state
 * that stranded Elena/Joaquin/Stephen. This test encodes those lessons as
 * assertions so the NEXT regression trips a test instead of a customer.
 *
 * Three read-only / pure checks, no side effects:
 *   A. First-order completion rate across REAL customers (the funnel health
 *      number — currently ~46%). Fails if it falls below a floor.
 *   B. Zero approved customers who cannot order. Reuses getPlatformVisibility
 *      (the /admin/platform engine), which runs the real checkOrderGate per
 *      client. Any approved-but-blocked account is a leak in progress.
 *   C. Every gate block reason returns an ACTIONABLE error body — a CTA and
 *      next steps — not a "contact support" dead-end. Pure function check.
 *
 * Run: npx -y dotenv-cli -e .env.local -- npx tsx scripts/activation-smoke-test.ts
 * Exit non-zero on any failure so it can gate a cron / CI.
 */

import { createClient } from '@supabase/supabase-js';
import { getPlatformVisibility } from '../lib/platform-visibility';
import { buildOrderGateErrorBody, type OrderGateResult } from '../lib/order-gate';
import { DO_NOT_SEND, looksDisposable } from '../lib/first-order-activation';

/** First-order completion rate must stay at or above this. */
const FIRST_ORDER_FLOOR = 0.40;

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    process.exit(2);
  }
  const admin = createClient(url, key);

  // ── A + B: platform-wide gate reality ──────────────────────────────────
  const { rows, summary } = await getPlatformVisibility(admin);

  // A. First-order completion rate (real customers only — summary excludes
  //    internal/demo). ordered = has ≥1 order; the module already computed it.
  const real = rows.filter((r) => !r.isInternal);
  const ordered = real.filter((r) => r.orderCount > 0).length;
  const rate = summary.total > 0 ? ordered / summary.total : 1;
  record(
    'first-order rate ≥ floor',
    rate >= FIRST_ORDER_FLOOR,
    `${(rate * 100).toFixed(0)}% (${ordered}/${summary.total}) ordered — floor ${(FIRST_ORDER_FLOOR * 100).toFixed(0)}%`,
  );

  // B. No approved customer may be unable to order. This is the direct guard
  //    for the Elena/Joaquin/Stephen class. But split cruft from real leaks:
  //    a disposable-domain junk signup or a do-not-send declined prospect is
  //    blocked-and-fine — hard-failing on those would train everyone to ignore
  //    a red test. Only a plausibly-real prospect being leaked is a failure;
  //    known cruft is reported as a warning to be cleaned up.
  const blocked = real.filter((r) => !r.canOrder);
  const cruft = blocked.filter((r) => DO_NOT_SEND.has(r.email.toLowerCase()) || looksDisposable(r.email));
  const leaks = blocked.filter((r) => !cruft.includes(r));
  record(
    'zero real prospects blocked',
    leaks.length === 0,
    leaks.length === 0
      ? `all activatable customers can order${cruft.length ? ` (${cruft.length} known-cruft account(s) ignored)` : ''}`
      : `${leaks.length} LEAKED: ` + leaks.map((b) => `${b.email} [${b.blocker}]`).join(', '),
  );
  if (cruft.length > 0) {
    console.log(`  ⚠  cleanup: ${cruft.length} blocked cruft account(s) should be archived — ` +
      cruft.map((c) => `${c.email} [${c.blocker}]`).join(', '));
  }

  // ── C. Every gate block reason is actionable ────────────────────────────
  // A blocked order must always tell the customer what to do about it.
  const base: OrderGateResult = {
    allowed: false, completedCount: 0, hasPaymentMethod: false, trialRemaining: 0,
    hasRecentPaidInvoice: false, hasMercuryEnrolled: false, hasBypass: false,
    isSandbox: false, clientName: 'Smoke Test',
  } as OrderGateResult;
  for (const reason of ['card_required', 'credits_required', 'mercury_required'] as const) {
    const body = buildOrderGateErrorBody({ ...base, reason } as OrderGateResult);
    const actionable = !!body.cta && !!body.cta.href && !!body.cta.label
      && Array.isArray(body.next_steps) && body.next_steps.length > 0
      && !/contact support\.?$/i.test(body.error);
    record(
      `gate '${reason}' is actionable`,
      actionable,
      actionable ? `CTA "${body.cta!.label}" → ${body.cta!.href}` : `DEAD-END: cta=${JSON.stringify(body.cta)} error="${body.error.slice(0, 60)}"`,
    );
  }

  // ── Report ──────────────────────────────────────────────────────────────
  console.log(`\nActivation smoke test — ${new Date().toISOString()}\n${'═'.repeat(78)}`);
  let fails = 0;
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'}  ${c.name.padEnd(38)}  ${c.detail}`);
    if (!c.ok) fails++;
  }
  console.log(`${'═'.repeat(78)}\nSUMMARY: ${checks.length - fails} passing / ${fails} failing\n`);
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => { console.error('activation-smoke-test threw:', e); process.exit(2); });
