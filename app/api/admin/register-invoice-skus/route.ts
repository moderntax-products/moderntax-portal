/**
 * POST /api/admin/register-invoice-skus
 *
 * Server-side equivalent of scripts/register-invoice-skus.ts — runs in
 * Vercel where STRIPE_SECRET_KEY is already configured, so admin doesn't
 * need to copy the secret down to .env.local. Same idempotent behavior:
 *
 *   1. For every entry in INVOICE_SKU_CATALOG (lib/pricing.ts):
 *      - Upsert a Stripe Product (looked up by metadata.sku)
 *      - Ensure an active Price matching the catalog amount (one_time
 *        or recurring monthly). Archives any stale active prices.
 *   2. Writes (product_id, price_id) back to public.invoice_sku_registry
 *      so runtime lookups can resolve a SKU → Stripe Price ID.
 *
 * Why this exists alongside the script:
 *   - Local-machine path (the script) requires STRIPE_SECRET_KEY in
 *     .env.local. We don't store it there by default; it lives only in
 *     Vercel's env. This endpoint runs server-side so the secret stays
 *     in Vercel.
 *   - Matches the Centerstone-cleanup / Q3-prepay pattern of one-shot
 *     admin endpoints triggered by curl.
 *
 * Mercury note: Mercury invoice line items are free-form (name +
 * unitPrice + quantity). The auto-invoice cron already references the
 * new SKUs by name and price; no "register in Mercury" step exists or
 * is needed. This endpoint is Stripe-only.
 *
 * Auth: CRON_SECRET only.
 *
 * Usage:
 *   curl -X POST "https://portal.moderntax.io/api/admin/register-invoice-skus" \\
 *     -H "Authorization: Bearer $CRON_SECRET"
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { INVOICE_SKU_CATALOG, type InvoiceSku } from '@/lib/pricing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

interface RegisterResult {
  sku: string;
  name: string;
  unitPrice: number;
  cadence: 'one_time' | 'monthly';
  stripeProductId: string;
  stripePriceId: string;
  productUpdated: boolean;
  priceChanged: boolean;
}

async function upsertProductAndPrice(stripe: Stripe, entry: InvoiceSku): Promise<RegisterResult> {
  // Look up existing product by metadata.sku (our stable key).
  const search = await stripe.products.search({
    query: `metadata['sku']:'${entry.sku}' AND active:'true'`,
  });

  let product: Stripe.Product;
  let productUpdated = false;
  if (search.data.length > 0) {
    product = search.data[0];
    const needsUpdate =
      product.name !== entry.name ||
      product.description !== entry.description ||
      JSON.stringify(product.metadata || {}) !== JSON.stringify({ sku: entry.sku, ...entry.stripeMetadata });
    if (needsUpdate) {
      product = await stripe.products.update(product.id, {
        name: entry.name,
        description: entry.description,
        metadata: { sku: entry.sku, ...entry.stripeMetadata },
      });
      productUpdated = true;
    }
  } else {
    product = await stripe.products.create({
      name: entry.name,
      description: entry.description,
      metadata: { sku: entry.sku, ...entry.stripeMetadata },
    });
    productUpdated = true;
  }

  const unitAmountCents = Math.round(entry.unitPrice * 100);
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const matching = prices.data.find((p) =>
    p.unit_amount === unitAmountCents &&
    p.currency === 'usd' &&
    ((entry.cadence === 'monthly' && p.recurring?.interval === 'month') ||
     (entry.cadence === 'one_time' && !p.recurring)),
  );

  let price: Stripe.Price;
  let priceChanged = false;
  if (matching) {
    price = matching;
  } else {
    // Archive stale prices (Stripe prices are immutable; new amount = new price).
    for (const stale of prices.data) {
      await stripe.prices.update(stale.id, { active: false });
    }
    price = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: unitAmountCents,
      ...(entry.cadence === 'monthly' ? { recurring: { interval: 'month' } } : {}),
      metadata: { sku: entry.sku },
    });
    priceChanged = true;
  }

  return {
    sku: entry.sku,
    name: entry.name,
    unitPrice: entry.unitPrice,
    cadence: entry.cadence,
    stripeProductId: product.id,
    stripePriceId: price.id,
    productUpdated,
    priceChanged,
  };
}

export async function POST(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({
      error: 'STRIPE_SECRET_KEY not configured in this environment. Set it in Vercel → Settings → Environment Variables before running.',
    }, { status: 500 });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' as any });
  const admin = createAdminClient();
  const log: string[] = [];
  const L = (s: string) => { log.push(s); console.log(`[register-invoice-skus] ${s}`); };

  // Verify the registry table exists. If not, surface the missing migration.
  const { error: tableProbe } = await admin.from('invoice_sku_registry').select('sku').limit(1);
  if (tableProbe && /relation .* does not exist|PGRST/i.test(tableProbe.message || '')) {
    return NextResponse.json({
      error: 'invoice_sku_registry table missing. Paste supabase/migration-invoice-sku-registry.sql in Studio first.',
      migration_pending: true,
    }, { status: 503 });
  }

  const results: RegisterResult[] = [];
  const errors: Array<{ sku: string; error: string }> = [];

  for (const entry of Object.values(INVOICE_SKU_CATALOG)) {
    try {
      const r = await upsertProductAndPrice(stripe, entry);
      L(`✓ ${entry.sku}: product=${r.stripeProductId} (${r.productUpdated ? 'updated' : 'unchanged'}), price=${r.stripePriceId} (${r.priceChanged ? 'new — old archived' : 'unchanged'})`);

      const { error: writeErr } = await (admin
        .from('invoice_sku_registry') as any)
        .upsert(
          {
            sku: entry.sku,
            name: entry.name,
            description: entry.description,
            unit_price: entry.unitPrice,
            cadence: entry.cadence,
            unit: entry.unit,
            stripe_product_id: r.stripeProductId,
            stripe_price_id: r.stripePriceId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'sku' },
        );
      if (writeErr) {
        L(`  ! registry write failed: ${writeErr.message}`);
        errors.push({ sku: entry.sku, error: `registry write: ${writeErr.message}` });
      }
      results.push(r);
    } catch (err: any) {
      L(`✗ ${entry.sku}: ${err?.message || err}`);
      errors.push({ sku: entry.sku, error: err?.message || String(err) });
    }
  }

  return NextResponse.json({
    success: errors.length === 0,
    registered: results.length,
    catalog_size: Object.keys(INVOICE_SKU_CATALOG).length,
    results,
    errors,
    mercury_note: 'Mercury line items are free-form (name + unit_price + quantity). No Mercury registration step needed; the auto-invoice cron references catalog entries by name + price directly.',
    log,
  });
}
