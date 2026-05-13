#!/usr/bin/env node
/**
 * One-shot: provision the Builds Collective Sandbox client + API key +
 * seeded demo entities so Collective can integration-test SSN-level
 * visibility + pass-through mismatch detection without exposure to real
 * production customer data.
 *
 * Collective's payments-underwriting use case is fundamentally different
 * from Vine's lender-spreading use case: they need to assess the human
 * behind the entity, not just the business credit profile. So this
 * sandbox seeds (business EIN, owner SSN) pairs that surface the
 * specific pattern Collective cares about — business looks clean,
 * but the owner has IRS exposure.
 *
 * Three demo cases, six entities total:
 *
 *   Case A — Pass-through mismatch (the killer demo):
 *     • Maple Construction LLC (EIN 87-1101010)  — clean 1120S, paid in full
 *     • John Sample (SSN 900-11-1010)            — 1040 w/ TC 290 audit
 *                                                  assessment on 2022 ($46K)
 *                                                  + unfiled 2023
 *
 *   Case B — Clean both (control case):
 *     • Beacon Logistics LLC (EIN 87-2202020)    — clean 1120S
 *     • Jane Sample (SSN 900-22-2020)            — clean 1040, strong AGI
 *
 *   Case C — Sole prop SSN-only:
 *     • Quincy Sample (SSN 900-33-3030)          — individual 1040 w/
 *                                                  Schedule C income,
 *                                                  clean filing history
 *
 * All SSNs use the IRS test range 900-XX-XXXX (flagged invalid, never
 * issued in production). EINs use 87-* prefix (training/test only).
 *
 * Idempotent: re-running regenerates the API key and replaces seeded
 * entities. Prints the new key (only once) + entity IDs at the end.
 *
 * Run with:
 *   npx -y dotenv-cli -e .env.local -- npx tsx scripts/provision-collective-sandbox.ts
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const CLIENT_NAME = 'Builds Collective Sandbox';
const CLIENT_SLUG = 'collective-sandbox';

function generateApiKey(): string {
  const rand = crypto.randomBytes(6).toString('hex');
  return `mt_live_txn_collective_sandbox_${rand}`;
}

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

interface DemoEntity {
  case_label: string;                       // human-readable case grouping for the credentials printout
  entity_name: string;
  tid: string;
  tid_kind: 'EIN' | 'SSN';
  // DB check constraint allows '1040' | '1065' | '1120' | '1120S'
  form_type: '1120S' | '1120' | '1065' | '1040';
  years: string[];
  signer_name: string;
  signer_email: string;
  address: { line1: string; city: string; state: string; zip: string };
  transcripts: {
    period_ending: string;
    /** AGI is 1040-specific. Set for SSN entities so extractIncomeSnapshot picks it up. */
    agi?: number | null;
    financials: Record<string, number | null>;
    transactions: { code: string; explanation: string; date: string; amount: string }[];
    /** When true, render a "No record of return filed" transcript instead of full data. */
    unfiled?: boolean;
  }[];
}

const DEMOS: DemoEntity[] = [
  // ─── Case A: Pass-through mismatch (THE KILLER DEMO) ────────────────
  {
    case_label: 'Case A — pass-through mismatch (clean business / problem owner)',
    entity_name: 'Maple Construction LLC',
    tid: '87-1101010',
    tid_kind: 'EIN',
    form_type: '1120S',
    years: ['2023'],
    signer_name: 'John Sample',
    signer_email: 'demo-john-sample@collective-sandbox.invalid',
    address: { line1: 'Demo Way Suite A', city: 'Charlotte', state: 'NC', zip: '28202' },
    transcripts: [
      {
        period_ending: '12-31-2023',
        financials: {
          grossReceipts: 1_240_000,
          totalIncome: 1_215_000,
          totalDeductions: 1_080_000,
          totalTax: 24_300,
          accountBalance: 0,
          accruedInterest: 0,
          accruedPenalty: 0,
        },
        transactions: [
          { code: '150', explanation: 'Tax return filed', date: '03-12-2024', amount: '$24,300.00' },
          { code: '610', explanation: 'Payment with return', date: '03-12-2024', amount: '-$24,300.00' },
        ],
      },
    ],
  },
  {
    case_label: 'Case A — pass-through mismatch (clean business / problem owner)',
    entity_name: 'John Sample',
    tid: '900-11-1010',
    tid_kind: 'SSN',
    form_type: '1040',
    years: ['2022', '2023'],
    signer_name: 'John Sample',
    signer_email: 'demo-john-sample@collective-sandbox.invalid',
    address: { line1: 'Demo Way Suite A', city: 'Charlotte', state: 'NC', zip: '28202' },
    transcripts: [
      {
        period_ending: '12-31-2022',
        agi: 312_400,
        financials: {
          grossReceipts: null,
          totalIncome: 312_400,
          totalDeductions: 28_700,
          totalTax: 78_950,
          accountBalance: 46_182.40,
          accruedInterest: 3_417.20,
          accruedPenalty: 4_897.00,
          accountBalancePlusAccruals: 54_496.60,
        },
        transactions: [
          { code: '150', explanation: 'Tax return filed', date: '04-15-2023', amount: '$32,768.00' },
          { code: '610', explanation: 'Payment with return', date: '04-15-2023', amount: '-$32,768.00' },
          { code: '420', explanation: 'Examination of tax return', date: '11-08-2023', amount: '$0.00' },
          { code: '290', explanation: 'Additional tax assessed by examination', date: '02-12-2024', amount: '$46,182.40' },
          { code: '196', explanation: 'Interest assessed', date: '02-12-2024', amount: '$3,417.20' },
          { code: '276', explanation: 'Failure-to-pay penalty', date: '02-12-2024', amount: '$4,897.00' },
        ],
      },
      {
        period_ending: '12-31-2023',
        unfiled: true,
        financials: {},
        transactions: [],
      },
    ],
  },

  // ─── Case B: Clean both (control case) ──────────────────────────────
  {
    case_label: 'Case B — clean control (both entity and owner clean)',
    entity_name: 'Beacon Logistics LLC',
    tid: '87-2202020',
    tid_kind: 'EIN',
    form_type: '1120S',
    years: ['2023'],
    signer_name: 'Jane Sample',
    signer_email: 'demo-jane-sample@collective-sandbox.invalid',
    address: { line1: 'Demo Blvd Suite B', city: 'Nashville', state: 'TN', zip: '37203' },
    transcripts: [
      {
        period_ending: '12-31-2023',
        financials: {
          grossReceipts: 2_180_000,
          totalIncome: 2_125_000,
          totalDeductions: 1_960_000,
          totalTax: 33_000,
          accountBalance: 0,
          accruedInterest: 0,
          accruedPenalty: 0,
        },
        transactions: [
          { code: '150', explanation: 'Tax return filed', date: '03-10-2024', amount: '$33,000.00' },
          { code: '610', explanation: 'Payment with return', date: '03-10-2024', amount: '-$33,000.00' },
        ],
      },
    ],
  },
  {
    case_label: 'Case B — clean control (both entity and owner clean)',
    entity_name: 'Jane Sample',
    tid: '900-22-2020',
    tid_kind: 'SSN',
    form_type: '1040',
    years: ['2023'],
    signer_name: 'Jane Sample',
    signer_email: 'demo-jane-sample@collective-sandbox.invalid',
    address: { line1: 'Demo Blvd Suite B', city: 'Nashville', state: 'TN', zip: '37203' },
    transcripts: [
      {
        period_ending: '12-31-2023',
        agi: 425_700,
        financials: {
          grossReceipts: null,
          totalIncome: 425_700,
          totalDeductions: 32_400,
          totalTax: 108_800,
          accountBalance: 0,
          accruedInterest: 0,
          accruedPenalty: 0,
        },
        transactions: [
          { code: '150', explanation: 'Tax return filed', date: '04-08-2024', amount: '$108,800.00' },
          { code: '610', explanation: 'Payment with return', date: '04-08-2024', amount: '-$108,800.00' },
        ],
      },
    ],
  },

  // ─── Case C: Sole prop SSN-only ─────────────────────────────────────
  {
    case_label: 'Case C — sole prop (SSN-only, no entity)',
    entity_name: 'Quincy Sample',
    tid: '900-33-3030',
    tid_kind: 'SSN',
    form_type: '1040',
    years: ['2023'],
    signer_name: 'Quincy Sample',
    signer_email: 'demo-quincy-sample@collective-sandbox.invalid',
    address: { line1: 'Demo St Suite C', city: 'Portland', state: 'OR', zip: '97204' },
    transcripts: [
      {
        period_ending: '12-31-2023',
        agi: 187_300,
        financials: {
          grossReceipts: 224_000, // Schedule C gross receipts
          totalIncome: 187_300,
          totalDeductions: 18_650,
          totalTax: 38_240,
          accountBalance: 0,
          accruedInterest: 0,
          accruedPenalty: 0,
        },
        transactions: [
          { code: '150', explanation: 'Tax return filed', date: '04-14-2024', amount: '$38,240.00' },
          { code: '610', explanation: 'Payment with return', date: '04-14-2024', amount: '-$38,240.00' },
        ],
      },
    ],
  },
];

/**
 * Render a synthetic IRS Record-of-Account-style HTML transcript. Mirrors
 * the Vine sandbox renderer (proven) but adds:
 *   - AGI ("ADJUSTED GROSS INCOME") line for 1040s so extractIncomeSnapshot
 *     populates income_snapshot.agi
 *   - "No record of return filed" path for unfiled-year entries so the
 *     screener flags them as CRITICAL/UNFILED
 */
function renderTranscriptHtml(d: DemoEntity, t: DemoEntity['transcripts'][number]): string {
  const taxYear = t.period_ending.split('-')[2];
  const fmtMoney = (n: number | null | undefined) => n === null || n === undefined ? '$0.00' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

  // Unfiled path — IRS returns a "No record of return filed" placeholder
  if (t.unfiled) {
    return `<!DOCTYPE html>
<html><head><title>Account Transcript — ${d.entity_name}</title></head><body>
<h1>This Product Contains Sensitive Taxpayer Data — DEMO/SYNTHETIC</h1>
<p style="background:#fffbe6;border:1px solid #fcd34d;padding:8px;">SANDBOX: Synthetic data for Builds Collective integration testing. Not a real IRS transcript.</p>

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

<h2>Account Summary</h2>
<pre>
No record of return filed
</pre>
</body></html>`;
  }

  const txRows = t.transactions.map(tx => `${tx.code}  ${tx.explanation}  ${tx.date}  ${tx.amount}`).join('\n');
  const agiLine = t.agi !== undefined && t.agi !== null
    ? `ADJUSTED GROSS INCOME:         ${fmtMoney(t.agi)}\n`
    : '';

  return `<!DOCTYPE html>
<html><head><title>Record of Account — ${d.entity_name}</title></head><body>
<h1>This Product Contains Sensitive Taxpayer Data — DEMO/SYNTHETIC</h1>
<p style="background:#fffbe6;border:1px solid #fcd34d;padding:8px;">SANDBOX: Synthetic data for Builds Collective integration testing. Not a real IRS transcript. SSNs in the 900-XX-XXXX range and EINs in the 87-XXXXXXX range are fabricated.</p>

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
${t.financials.grossReceipts !== null && t.financials.grossReceipts !== undefined ? `GROSS RECEIPTS:                ${fmtMoney(t.financials.grossReceipts as number)}\n` : ''}TOTAL INCOME:                  ${fmtMoney(t.financials.totalIncome as number | null)}
${agiLine}TOTAL DEDUCTIONS:              ${fmtMoney(t.financials.totalDeductions as number | null)}
TOTAL TAX:                     ${fmtMoney(t.financials.totalTax as number | null)}
ACCOUNT BALANCE:               ${fmtMoney(t.financials.accountBalance as number | null)}
ACCRUED INTEREST:              ${fmtMoney(t.financials.accruedInterest as number | null)}
ACCRUED PENALTY:               ${fmtMoney(t.financials.accruedPenalty as number | null)}
${(t.financials as any).accountBalancePlusAccruals !== undefined && (t.financials as any).accountBalancePlusAccruals !== null ? `ACCOUNT BALANCE PLUS ACCRUALS: ${fmtMoney((t.financials as any).accountBalancePlusAccruals)}` : ''}
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
  console.log(`\n=== Provisioning Builds Collective Sandbox ===`);

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
      process.exit(1);
    }
    clientId = existing.id;
  } else {
    const { data: created, error } = await sb.from('clients').insert({
      name: CLIENT_NAME,
      slug: CLIENT_SLUG,
      domain: 'collective-sandbox.invalid',
      api_key: apiKey,
      api_key_hash: apiKeyHash,
      free_trial: true,
      billing_model: 'per_tin',
      billing_payment_method: null,
      monitoring_default_enabled: false,
      intake_methods: ['api'],
    } as any).select('id').single() as { data: { id: string } | null; error: any };
    if (error || !created) {
      console.error(`✗ Couldn't create client: ${error?.message}`);
      console.error(`  If error is "column api_key_hash does not exist" — paste the api_key_hashing SQL first.`);
      process.exit(1);
    }
    clientId = created.id;
    console.log(`✓ Created Builds Collective Sandbox client (${clientId})`);
  }

  // Wipe prior sandbox requests + entities
  const { data: priorReqs } = await sb.from('requests').select('id').eq('client_id', clientId);
  for (const r of (priorReqs || [])) {
    await sb.from('request_entities').delete().eq('request_id', r.id);
    await sb.from('requests').delete().eq('id', r.id);
  }
  console.log(`✓ Cleared ${priorReqs?.length || 0} prior sandbox request(s)`);

  // requests.requested_by FK lookup
  let requestedBy: string | null = null;
  const { data: matt } = await sb.from('profiles').select('id').eq('email', 'matt@moderntax.io').maybeSingle() as { data: { id: string } | null };
  if (matt) {
    requestedBy = matt.id;
  } else {
    const { data: anyProfile } = await sb.from('profiles').select('id').limit(1).maybeSingle() as { data: { id: string } | null };
    if (anyProfile) requestedBy = anyProfile.id;
  }
  if (!requestedBy) {
    console.error(`✗ No profiles found to use as requested_by. Sign into the portal at least once first.`);
    process.exit(1);
  }

  const { data: req, error: reqErr } = await sb.from('requests').insert({
    client_id: clientId,
    requested_by: requestedBy,
    loan_number: 'COLLECTIVE-SANDBOX-001',
    status: 'completed',
    completed_at: new Date().toISOString(),
    intake_method: 'api',
    product_type: 'transcript',
    external_request_token: crypto.randomBytes(16).toString('hex'),
    notes: 'Builds Collective sandbox — synthetic SSN + EIN data, no real customer info.',
  } as any).select('id').single() as { data: { id: string } | null; error: any };
  if (reqErr || !req) {
    console.error(`✗ Couldn't create sandbox request: ${reqErr?.message}`);
    process.exit(1);
  }
  console.log(`✓ Created sandbox request (${req.id})`);

  const seeded: { caseLabel: string; name: string; tid: string; tidKind: string; id: string }[] = [];
  for (const d of DEMOS) {
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
      signed_8821_url: `collective-sandbox/demo-8821-${d.tid.replace(/-/g, '')}.pdf`,
      signature_id: `SANDBOX-${d.tid.replace(/-/g, '')}`,
      signature_created_at: new Date().toISOString(),
    } as any).select('id').single() as { data: { id: string } | null; error: any };
    if (entErr || !ent) {
      console.error(`✗ Couldn't create entity ${d.entity_name}: ${entErr?.message}`);
      continue;
    }
    seeded.push({ caseLabel: d.case_label, name: d.entity_name, tid: d.tid, tidKind: d.tid_kind, id: ent.id });

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
    await sb.from('request_entities').update({
      transcript_html_urls: htmlPaths,
      transcript_urls: htmlPaths,
    }).eq('id', ent.id);
    console.log(`✓ Seeded ${d.entity_name.padEnd(30)} (${d.tid_kind} ${d.tid}) → ${htmlPaths.length} transcript${htmlPaths.length === 1 ? '' : 's'}`);
  }

  // ─── Print credentials ───────────────────────────────────────────────
  console.log(`\n\n${'═'.repeat(78)}`);
  console.log(`COLLECTIVE SANDBOX READY — credentials below (printed ONCE)`);
  console.log(`${'═'.repeat(78)}\n`);
  console.log(`Client:    ${CLIENT_NAME}`);
  console.log(`Client ID: ${clientId}`);
  console.log(`\nx-api-key header:`);
  console.log(`  ${apiKey}\n`);
  console.log(`Seeded entities, grouped by demo case:\n`);

  const cases = new Map<string, typeof seeded>();
  for (const s of seeded) {
    if (!cases.has(s.caseLabel)) cases.set(s.caseLabel, []);
    cases.get(s.caseLabel)!.push(s);
  }
  for (const [caseLabel, entries] of cases.entries()) {
    console.log(`  ${caseLabel}`);
    for (const e of entries) {
      console.log(`    · ${e.tidKind.padEnd(3)} ${e.tid.padEnd(13)} ${e.name.padEnd(28)} → ${e.id}`);
    }
    console.log();
  }

  // Suggest curls against Case A — the pass-through mismatch killer demo
  const caseA = seeded.filter(s => s.caseLabel.startsWith('Case A'));
  const ein = caseA.find(s => s.tidKind === 'EIN');
  const ssn = caseA.find(s => s.tidKind === 'SSN');

  console.log(`Quick test — Case A pass-through mismatch (clean business / problem owner):\n`);
  if (ein) {
    console.log(`  # Business EIN — should return clean 1120S, no flags`);
    console.log(`  curl -H "x-api-key: ${apiKey}" \\`);
    console.log(`    https://portal.moderntax.io/api/v1/transcripts/${ein.id}/structured | jq .compliance`);
    console.log();
  }
  if (ssn) {
    console.log(`  # Owner SSN — should return CRITICAL with TC 290 audit + unfiled 2023`);
    console.log(`  curl -H "x-api-key: ${apiKey}" \\`);
    console.log(`    https://portal.moderntax.io/api/v1/transcripts/${ssn.id}/structured | jq .compliance`);
    console.log();
  }
  console.log(`${'═'.repeat(78)}\n`);
}
