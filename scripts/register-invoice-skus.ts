/**
 * scripts/register-invoice-skus.ts
 *
 * One-shot, idempotent setup script: walks INVOICE_SKU_CATALOG from
 * lib/pricing.ts and registers each SKU into:
 *   1. Stripe — as a Product with a recurring (monthly) or one_time Price.
 *      Writes the stripe_product_id + stripe_price_id back into the
 *      `invoice_sku_registry` Supabase table for the auto-invoice cron
 *      and the per-loan billing forecast widget to read.
 *   2. Mercury — Mercury does not have a product catalog API; line items
 *      on invoices are free-form name + unitPrice. Instead of registering,
 *      this script writes a Markdown reference doc to
 *      docs/mercury-line-items.md so Matt (or anyone composing a manual
 *      Mercury invoice) has the exact name + price for each SKU.
 *
 * Idempotent — re-running:
 *   - Updates Stripe Product name/description/metadata if drifted
 *   - Creates a new Stripe Price only when the unitPrice changed (Stripe
 *     prices are immutable; we archive the old one + create a fresh one)
 *   - Refreshes the Markdown doc
 *
 * Run:
 *   npx -y dotenv-cli -e .env.local -- npx tsx scripts/register-invoice-skus.ts
 *
 * Required env:
 *   STRIPE_SECRET_KEY
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Driver: 2026-05-28 Matt — three new SKUs (Reorder, Post-Close Monitoring,
 * Consolidation Report) need to flow through both Stripe (for card-pay
 * customers) and Mercury (for ACH-invoice customers). One catalog file,
 * one registration script keeps the two billing systems in sync with the
 * UI surfaces.
 */

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { INVOICE_SKU_CATALOG, type InvoiceSku } from '../lib/pricing';

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

const stripe = new Stripe(requireEnv('STRIPE_SECRET_KEY'), { apiVersion: '2024-06-20' as any });
const supabase = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'));

async function ensureRegistryTable() {
  // Best-effort — the table SHOULD have been created via the migration in
  // supabase/migration-invoice-sku-registry.sql. We just verify it's
  // reachable. If it 404s, surface the migration instructions.
  const { error } = await supabase.from('invoice_sku_registry').select('sku').limit(1);
  if (error && /relation .* does not exist|PGRST/i.test(error.message)) {
    throw new Error(
      'invoice_sku_registry table missing. Paste supabase/migration-invoice-sku-registry.sql in Studio first.',
    );
  }
}

interface RegisterResult {
  sku: string;
  stripeProductId: string;
  stripePriceId: string;
  priceChanged: boolean;
  productUpdated: boolean;
}

async function upsertStripeProductAndPrice(entry: InvoiceSku): Promise<RegisterResult> {
  // Look up existing Stripe product by SKU metadata. We use metadata.sku
  // as the stable lookup key (Stripe doesn't enforce uniqueness on it,
  // but our catalog is authoritative).
  const existingProducts = await stripe.products.search({
    query: `metadata['sku']:'${entry.sku}' AND active:'true'`,
  });

  let product: Stripe.Product;
  let productUpdated = false;
  if (existingProducts.data.length > 0) {
    product = existingProducts.data[0];
    // Update if name / description / metadata drifted.
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

  // Find an existing active Price on this product matching unit amount + cadence.
  const unitAmountCents = Math.round(entry.unitPrice * 100);
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const matchingPrice = prices.data.find((p) =>
    p.unit_amount === unitAmountCents &&
    p.currency === 'usd' &&
    ((entry.cadence === 'monthly' && p.recurring?.interval === 'month') ||
     (entry.cadence === 'one_time' && !p.recurring)),
  );

  let price: Stripe.Price;
  let priceChanged = false;
  if (matchingPrice) {
    price = matchingPrice;
  } else {
    // Archive any stale active prices on this product (Stripe prices are
    // immutable, so a unit_amount change means new price + archive old).
    for (const stale of prices.data) {
      await stripe.prices.update(stale.id, { active: false });
    }
    price = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: unitAmountCents,
      ...(entry.cadence === 'monthly'
        ? { recurring: { interval: 'month' } }
        : {}),
      metadata: { sku: entry.sku },
    });
    priceChanged = true;
  }

  return {
    sku: entry.sku,
    stripeProductId: product.id,
    stripePriceId: price.id,
    priceChanged,
    productUpdated,
  };
}

async function writeBackToSupabase(entry: InvoiceSku, result: RegisterResult) {
  const { error } = await supabase
    .from('invoice_sku_registry')
    .upsert(
      {
        sku: entry.sku,
        name: entry.name,
        description: entry.description,
        unit_price: entry.unitPrice,
        cadence: entry.cadence,
        unit: entry.unit,
        stripe_product_id: result.stripeProductId,
        stripe_price_id: result.stripePriceId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'sku' },
    );
  if (error) throw new Error(`Supabase write failed for ${entry.sku}: ${error.message}`);
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function writeMercuryReferenceDoc(results: RegisterResult[]) {
  const lines: string[] = [];
  lines.push('# Mercury Invoice Line-Item Reference');
  lines.push('');
  lines.push('> Auto-generated by `scripts/register-invoice-skus.ts`. Do not edit by hand.');
  lines.push('> Mercury does not have a product catalog API; line items on invoices are');
  lines.push('> free-form `name` + `unitPrice`. Use the exact strings below when composing');
  lines.push('> Mercury invoices manually or in code (`lib/mercury.ts createMercuryInvoice`).');
  lines.push('');
  lines.push('| SKU | Line-Item Name | Unit Price | Cadence | Unit | Stripe Product ID |');
  lines.push('|---|---|---:|---|---|---|');
  for (const entry of Object.values(INVOICE_SKU_CATALOG)) {
    const r = results.find((x) => x.sku === entry.sku);
    lines.push(
      `| \`${entry.sku}\` | ${entry.name} | ${fmtUsd(entry.unitPrice)} | ${entry.cadence} | ${entry.unit} | \`${r?.stripeProductId || '(not registered yet)'}\` |`,
    );
  }
  lines.push('');
  lines.push('## Description copy for invoice PDFs');
  lines.push('');
  for (const entry of Object.values(INVOICE_SKU_CATALOG)) {
    lines.push(`### ${entry.name}`);
    lines.push('');
    lines.push(`> ${entry.description}`);
    lines.push('');
  }

  const docsDir = join(process.cwd(), 'docs');
  mkdirSync(docsDir, { recursive: true });
  const outPath = join(docsDir, 'mercury-line-items.md');
  writeFileSync(outPath, lines.join('\n'));
  console.log(`✓ Wrote ${outPath}`);
}

async function main() {
  console.log('=== Registering INVOICE_SKU_CATALOG with Stripe + writing Mercury reference ===\n');

  await ensureRegistryTable();

  const results: RegisterResult[] = [];
  for (const entry of Object.values(INVOICE_SKU_CATALOG)) {
    console.log(`\n--- ${entry.sku} (${fmtUsd(entry.unitPrice)} / ${entry.cadence}) ---`);
    try {
      const r = await upsertStripeProductAndPrice(entry);
      console.log(`  Stripe product: ${r.stripeProductId} ${r.productUpdated ? '(updated)' : '(unchanged)'}`);
      console.log(`  Stripe price:   ${r.stripePriceId} ${r.priceChanged ? '(new — old archived)' : '(unchanged)'}`);
      await writeBackToSupabase(entry, r);
      console.log(`  ✓ Wrote to invoice_sku_registry`);
      results.push(r);
    } catch (err) {
      console.error(`  ✗ Failed: ${(err as Error).message}`);
    }
  }

  console.log('\n=== Writing Mercury reference doc ===');
  writeMercuryReferenceDoc(results);

  console.log('\n=== Done ===');
  console.log(`Registered ${results.length} of ${Object.keys(INVOICE_SKU_CATALOG).length} SKUs.`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
