#!/usr/bin/env node
/**
 * One-shot: provision the Vine Sandbox client + API key + 3 seeded
 * demo entities so the Vine team can integration-test the v1
 * structured + cross-reference endpoints end-to-end without any
 * exposure to real production customer data.
 *
 * Three demo entities (synthetic transcripts, real-looking financials):
 *   1. Apex Coffee LLC      — 1120-S 2023, clean (no balance, paid in full)
 *   2. Sunrise Plumbing Co  — 1120-S 2023, balance due + accruing interest
 *   3. Independence Tax Co  — 1065 2022 + 2023, prior balance closed
 *
 * Synthetic transcripts mimic the modern IRS HTML structure
 * (item-container divs + plain-text TC blocks) so the existing
 * screenTranscriptHtml parser extracts them correctly. All
 * identifying fields are fabricated:
 *   • EINs use the IRS test/training prefix 87-* (not a real
 *     issuing range for production businesses)
 *   • Business names + addresses are obviously fake
 *
 * Idempotent: re-running with the same slug regenerates a fresh API
 * key and replaces seeded entities. Prints the new key (only once) +
 * 3 entity IDs at the end.
 *
 * Run with:
 *   npx -y dotenv-cli -e .env.local -- npx tsx scripts/provision-vine-sandbox.ts
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';

// Load env first
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const CLIENT_NAME = 'Vine Sandbox';
const CLIENT_SLUG = 'vine-sandbox';

// API key format: mt_live_txn_<slug>_<8-char-rand>
function generateApiKey(): string {
  const rand = crypto.randomBytes(6).toString('hex'); // 12 hex chars
  return `mt_live_txn_vine_sandbox_${rand}`;
}

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

interface DemoEntity {
  entity_name: string;
  tid: string;
  tid_kind: 'EIN' | 'SSN';
  form_type: '1120-S' | '1120' | '1065' | '1040';
  years: string[];
  signer_name: string;
  signer_email: string;
  address: { line1: string; city: string; state: string; zip: string };
  /** Pre-built synthetic transcripts to upload as HTML. */
  transcripts: { period_ending: string; financials: Record<string, number | null>; transactions: { code: string; explanation: string; date: string; amount: string }[] }[];
}

const DEMOS: DemoEntity[] = [
  {
    entity_name: 'Apex Coffee Roasters LLC',
    tid: '87-0000101',
    tid_kind: 'EIN',
    form_type: '1120-S',
    years: ['2023'],
    signer_name: 'Demo Owner One',
    signer_email: 'demo-signer-1@vine-sandbox.invalid',
    address: { line1: '101 Demo Way', city: 'Austin', state: 'TX', zip: '78701' },
    transcripts: [
      {
        period_ending: '12-31-2023',
        financials: {
          grossReceipts: 1_842_500,
          totalIncome: 1_842_500,
          totalDeductions: 1_695_200,
          totalTax: 31_650,
          accountBalance: 0,
          accruedInterest: 0,
          accruedPenalty: 0,
        },
        transactions: [
          { code: '150', explanation: 'Tax return filed', date: '03-14-2024', amount: '$31,650.00' },
          { code: '610', explanation: 'Payment with return', date: '03-14-2024', amount: '-$31,650.00' },
          { code: '670', explanation: 'Subsequent payment', date: '04-15-2024', amount: '-$8,000.00' },
          { code: '670', explanation: 'Subsequent payment', date: '06-15-2024', amount: '-$8,000.00' },
          { code: '670', explanation: 'Subsequent payment', date: '09-15-2024', amount: '-$8,000.00' },
        ],
      },
    ],
  },
  {
    entity_name: 'Sunrise Plumbing Co',
    tid: '87-0000202',
    tid_kind: 'EIN',
    form_type: '1120-S',
    years: ['2023'],
    signer_name: 'Demo Owner Two',
    signer_email: 'demo-signer-2@vine-sandbox.invalid',
    address: { line1: '202 Demo Blvd', city: 'Denver', state: 'CO', zip: '80201' },
    transcripts: [
      {
        period_ending: '12-31-2023',
        financials: {
          grossReceipts: 985_000,
          totalIncome: 950_400,
          totalDeductions: 810_000,
          totalTax: 28_550,
          accountBalance: 14_287.21,
          accruedInterest: 842.13,
          accruedPenalty: 1_205.50,
          accountBalancePlusAccruals: 16_334.84,
        },
        transactions: [
          { code: '150', explanation: 'Tax return filed', date: '03-15-2024', amount: '$28,550.00' },
          { code: '610', explanation: 'Payment with return', date: '03-15-2024', amount: '-$14,262.79' },
          { code: '276', explanation: 'Failure-to-pay penalty', date: '04-16-2024', amount: '$1,205.50' },
          { code: '196', explanation: 'Interest assessed', date: '04-16-2024', amount: '$842.13' },
        ],
      },
    ],
  },
  {
    entity_name: 'Independence Tax Co LLC',
    tid: '87-0000303',
    tid_kind: 'EIN',
    form_type: '1065',
    years: ['2022', '2023'],
    signer_name: 'Demo Owner Three',
    signer_email: 'demo-signer-3@vine-sandbox.invalid',
    address: { line1: '303 Demo St', city: 'Philadelphia', state: 'PA', zip: '19103' },
    transcripts: [
      {
        period_ending: '12-31-2022',
        financials: {
          grossReceipts: 2_450_000,
          totalIncome: 2_398_700,
          totalDeductions: 2_180_000,
          totalTax: 0, // 1065 partnerships don't pay entity-level tax
          accountBalance: 0,
          accruedInterest: 0,
          accruedPenalty: 0,
        },
        transactions: [
          { code: '150', explanation: 'Tax return filed', date: '04-12-2023', amount: '$0.00' },
        ],
      },
      {
        period_ending: '12-31-2023',
        financials: {
          grossReceipts: 2_760_500,
          totalIncome: 2_695_000,
          totalDeductions: 2_410_000,
          totalTax: 0,
          accountBalance: 0,
          accruedInterest: 0,
          accruedPenalty: 0,
        },
        transactions: [
          { code: '460', explanation: 'Extension of time to file granted', date: '04-15-2024', amount: '$0.00' },
          { code: '150', explanation: 'Tax return filed', date: '09-12-2024', amount: '$0.00' },
        ],
      },
    ],
  },
];

/**
 * Render a synthetic IRS Record-of-Account-style HTML transcript. Mimics
 * the modern IRS TDS structure (item-container/item-label/item-value)
 * enough for screenTranscriptHtml to extract all the fields we want.
 */
function renderTranscriptHtml(d: DemoEntity, t: DemoEntity['transcripts'][number]): string {
  const taxYear = t.period_ending.split('-')[2];
  const fmtMoney = (n: number | null) => n === null ? '$0.00' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const txRows = t.transactions.map(tx => `${tx.code}  ${tx.explanation}  ${tx.date}  ${tx.amount}`).join('\n');

  return `<!DOCTYPE html>
<html><head><title>Record of Account — ${d.entity_name}</title></head><body>
<h1>This Product Contains Sensitive Taxpayer Data — DEMO/SYNTHETIC</h1>
<p style="background:#fffbe6;border:1px solid #fcd34d;padding:8px;">SANDBOX: Synthetic data for Vine Partnership integration testing. Not a real IRS transcript. EINs in the 87-0000xxx range are fabricated.</p>

<div class="item-container">
  <dt class="item-label">Form Number:</dt>
  <dd class="item-value">${d.form_type}</dd>
</div>
<div class="item-container">
  <dt class="item-label">Taxpayer Identification Number:</dt>
  <dd class="item-value">${d.tid}</dd>
</div>
<div class="item-container">
  <dt class="item-label">Report for Tax Period Ending:</dt>
  <dd class="item-value">${t.period_ending}</dd>
</div>
<div class="item-container">
  <dt class="item-label">Tracking ID:</dt>
  <dd class="item-value">${Math.floor(100000000000 + Math.random() * 900000000000)}</dd>
</div>
<div class="item-container">
  <dt class="item-label">Date of Issue:</dt>
  <dd class="item-value">05-13-2026</dd>
</div>

<h2>Taxpayer</h2>
<table><tr><td class="monospace" align="left">${d.entity_name}</td></tr>
<tr><td>${d.address.line1}</td></tr>
<tr><td>${d.address.city}, ${d.address.state} ${d.address.zip}</td></tr></table>

<h2>Account Summary (Tax Year ${taxYear})</h2>
<pre>
GROSS RECEIPTS:                ${fmtMoney(t.financials.grossReceipts)}
TOTAL INCOME:                  ${fmtMoney(t.financials.totalIncome)}
TOTAL DEDUCTIONS:              ${fmtMoney(t.financials.totalDeductions)}
TOTAL TAX:                     ${fmtMoney(t.financials.totalTax)}
ACCOUNT BALANCE:               ${fmtMoney(t.financials.accountBalance)}
ACCRUED INTEREST:              ${fmtMoney(t.financials.accruedInterest)}
ACCRUED PENALTY:               ${fmtMoney(t.financials.accruedPenalty)}
${t.financials.accountBalancePlusAccruals !== undefined && t.financials.accountBalancePlusAccruals !== null ? `ACCOUNT BALANCE PLUS ACCRUALS: ${fmtMoney(t.financials.accountBalancePlusAccruals)}` : ''}
</pre>

<h2>Transactions</h2>
<pre>
CODE  EXPLANATION OF TRANSACTION                       CYCLE       DATE           AMOUNT
${txRows}
</pre>

</body></html>`;
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

async function main() {
  console.log(`\n=== Provisioning Vine Sandbox ===`);

  // 1. Upsert the client
  const apiKey = generateApiKey();
  const apiKeyHash = sha256Hex(apiKey);

  const { data: existing } = await sb.from('clients').select('id, name').eq('slug', CLIENT_SLUG).maybeSingle() as { data: any };

  let clientId: string;
  if (existing) {
    console.log(`✓ Found existing client ${existing.name} (${existing.id}) — rotating API key`);
    const { error } = await sb.from('clients').update({
      api_key: apiKey,
      api_key_hash: apiKeyHash,
    } as any).eq('id', existing.id);
    if (error) {
      console.error(`✗ Couldn't update existing client: ${error.message}`);
      console.error(`  This usually means the api_key_hash migration hasn't been run yet.`);
      console.error(`  Paste the SQL from scripts/run-these-migrations.sql (api_key_hashing section) into Supabase Studio first.`);
      process.exit(1);
    }
    clientId = existing.id;
  } else {
    const { data: created, error } = await sb.from('clients').insert({
      name: CLIENT_NAME,
      slug: CLIENT_SLUG,
      domain: 'vine-sandbox.invalid',
      api_key: apiKey,
      api_key_hash: apiKeyHash,
      free_trial: true,
      billing_model: 'payg',
      billing_payment_method: 'none',
      monitoring_default_enabled: false,
      intake_methods: ['api'],
    } as any).select('id').single() as { data: { id: string } | null; error: any };
    if (error || !created) {
      console.error(`✗ Couldn't create client: ${error?.message}`);
      console.error(`  If error is "column api_key_hash does not exist" — paste the api_key_hashing SQL first.`);
      process.exit(1);
    }
    clientId = created.id;
    console.log(`✓ Created Vine Sandbox client (${clientId})`);
  }

  // 2. Wipe any prior sandbox entities + requests under this client
  const { data: priorReqs } = await sb.from('requests').select('id').eq('client_id', clientId);
  for (const r of (priorReqs || [])) {
    await sb.from('request_entities').delete().eq('request_id', r.id);
    await sb.from('requests').delete().eq('id', r.id);
  }
  console.log(`✓ Cleared ${priorReqs?.length || 0} prior sandbox request(s)`);

  // 3. Create a single sandbox request with all 3 demo entities under it
  const { data: req, error: reqErr } = await sb.from('requests').insert({
    client_id: clientId,
    loan_number: 'VINE-SANDBOX-001',
    status: 'completed',
    completed_at: new Date().toISOString(),
    intake_method: 'api',
    product_type: 'transcript',
    external_request_token: crypto.randomBytes(16).toString('hex'),
    notes: 'Vine Partnership sandbox — synthetic data only, no real customer info.',
  } as any).select('id').single() as { data: { id: string } | null; error: any };
  if (reqErr || !req) {
    console.error(`✗ Couldn't create sandbox request: ${reqErr?.message}`);
    process.exit(1);
  }
  console.log(`✓ Created sandbox request (${req.id})`);

  // 4. For each demo entity: upload transcript HTMLs to storage + insert entity row
  const entityIds: { name: string; id: string }[] = [];
  for (const d of DEMOS) {
    // Create entity row first to get the ID for storage paths
    const { data: ent, error: entErr } = await sb.from('request_entities').insert({
      request_id: req.id,
      entity_name: d.entity_name,
      tid: d.tid,
      tid_kind: d.tid_kind,
      form_type: d.form_type,
      years: d.years,
      signer_first_name: d.signer_name.split(' ')[0],
      signer_last_name: d.signer_name.split(' ').slice(1).join(' '),
      signer_email: d.signer_email,
      address: d.address.line1,
      city: d.address.city,
      state: d.address.state,
      zip_code: d.address.zip,
      status: 'completed',
      completed_at: new Date().toISOString(),
      signed_8821_url: `vine-sandbox/demo-8821-${d.tid.replace('-', '')}.pdf`,
      signature_id: `SANDBOX-${d.tid.replace('-', '')}`,
      signature_created_at: new Date().toISOString(),
    } as any).select('id').single() as { data: { id: string } | null; error: any };
    if (entErr || !ent) {
      console.error(`✗ Couldn't create entity ${d.entity_name}: ${entErr?.message}`);
      continue;
    }
    entityIds.push({ name: d.entity_name, id: ent.id });

    // Upload each transcript HTML
    const htmlPaths: string[] = [];
    for (const t of d.transcripts) {
      const html = renderTranscriptHtml(d, t);
      const filename = `${Date.now()}-${d.entity_name.replace(/[^a-zA-Z0-9]/g, '_')}-${d.form_type}-${t.period_ending.split('-')[2]}.html`;
      const storagePath = `transcripts/${ent.id}/${filename}`;
      const { error: upErr } = await sb.storage.from('uploads').upload(storagePath, Buffer.from(html, 'utf-8'), {
        contentType: 'text/html',
        upsert: true,
      });
      if (upErr) {
        console.error(`✗ Upload failed for ${filename}: ${upErr.message}`);
        continue;
      }
      htmlPaths.push(storagePath);
    }
    // Update entity with the transcript URLs
    await sb.from('request_entities').update({
      transcript_html_urls: htmlPaths,
      transcript_urls: htmlPaths,
    }).eq('id', ent.id);
    console.log(`✓ Seeded ${d.entity_name} (${ent.id.slice(0, 8)}…) with ${htmlPaths.length} transcript${htmlPaths.length === 1 ? '' : 's'}`);
  }

  // ─── Print the credentials block ─────────────────────────────────────
  console.log(`\n\n${'═'.repeat(72)}`);
  console.log(`VINE SANDBOX READY — credentials below (printed ONCE, not stored anywhere else)`);
  console.log(`${'═'.repeat(72)}\n`);
  console.log(`Client:   ${CLIENT_NAME}`);
  console.log(`Client ID: ${clientId}`);
  console.log(`\nx-api-key header:\n  ${apiKey}\n`);
  console.log(`Demo entities (use as {entityId} in the curl examples):`);
  for (const e of entityIds) {
    console.log(`  · ${e.name.padEnd(30)} → ${e.id}`);
  }
  console.log(`\nQuick test:`);
  console.log(`  curl -H "x-api-key: ${apiKey}" \\`);
  console.log(`    https://portal.moderntax.io/api/v1/transcripts/${entityIds[0]?.id}/structured | jq .`);
  console.log(`\n  curl -X POST -H "x-api-key: ${apiKey}" \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"tax_year":"2023","self_reported":{"gross_receipts":1842500,"total_income":1842500}}' \\`);
  console.log(`    https://portal.moderntax.io/api/v1/transcripts/${entityIds[0]?.id}/cross-reference | jq .`);
  console.log(`\n${'═'.repeat(72)}\n`);
}
