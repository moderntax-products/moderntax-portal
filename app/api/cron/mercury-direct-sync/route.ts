/**
 * GET /api/cron/mercury-direct-sync
 *
 * Weekly re-sync of the ModernTax Direct paying-customer flag. Re-pulls Mercury
 * paid invoices + the "ModernTax Direct" client roster and rewrites
 * gross_receipts.direct_customer across matching entities, so the Compliance
 * Audit board's "Direct customer" signal stays current as new payments land.
 *
 * Pure data sync (no external sends) — always runs; no shadow gate. Requires
 * MERCURY_API_TOKEN (whitelisted on Vercel); fails soft if Mercury is
 * unreachable so a bad week never 500s the cron.
 *
 * Auth: Vercel cron Bearer secret (CRON_SECRET).
 * Matt 2026-07-28.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { syncDirectCustomersFromMercury } from '@/lib/direct-customer-sync';

export const maxDuration = 60;
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const dryRun = new URL(request.url).searchParams.get('dryRun') === '1';
  const admin = createAdminClient();

  try {
    const result = await syncDirectCustomersFromMercury(admin, { dryRun });
    console.log(
      `[mercury-direct-sync] ${dryRun ? 'DRY-RUN ' : ''}payers=${result.directPayers.length} ` +
      `tagged=${result.taggedEntities.length} directClient=${result.directClientEntities} ` +
      `undeliverable=${result.undeliverable.length} errors=${result.errors.length}`,
    );
    if (result.undeliverable.length) console.warn('[mercury-direct-sync] undeliverable emails:', result.undeliverable);
    if (result.errors.length) console.warn('[mercury-direct-sync] errors:', result.errors);
    return NextResponse.json({
      ok: true,
      dryRun,
      payers: result.directPayers.map((p) => ({ name: p.name, paid: p.paid })),
      tagged: result.taggedEntities.length,
      directClientEntities: result.directClientEntities,
      undeliverable: result.undeliverable,
      errors: result.errors,
    });
  } catch (err: any) {
    console.error('[mercury-direct-sync] fatal:', err);
    // Soft-fail: return 200 so Vercel doesn't retry-storm on a transient outage.
    return NextResponse.json({ ok: false, error: err?.message || 'sync failed' });
  }
}
