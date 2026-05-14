#!/usr/bin/env node
/**
 * One-shot: provision the Moxie Money Sandbox client + API key + 6
 * seeded demo entities so Moxie can integration-test the API-tier
 * features they evaluated last week (8821 expiration alerts, monitoring
 * cadences, change tracking, newly-incorporated baseline) without any
 * exposure to real production customer data.
 *
 * Moxie's payments-meets-monitoring use case differs from Vine
 * (one-shot lender spreading) and Collective (SSN-level pass-through):
 * they need to see the LIFECYCLE features — 8821 validity tracking,
 * monitoring enrollment-without-pull, change diffs across pulls,
 * newly-incorporated baseline capture — that the prior two sandboxes
 * don't exercise.
 *
 * Six demo entities, each in a different state along the 7-year 8821
 * lifecycle the cron tracks:
 *
 *   Case 1 — Mountain Brew Coffee LLC
 *     8821 signed 2026-04-15 (28 days ago). Active quarterly monitoring.
 *     No alerts firing. Demonstrates baseline "healthy account" state.
 *
 *   Case 2 — Sunset Logistics Inc
 *     8821 signed 2019-08-13 (~6.75 years ago). Expires 2026-08-13.
 *     Demonstrates the 90-day informational alert window.
 *
 *   Case 3 — Beacon Wholesale Co
 *     8821 signed 2019-05-20 (~7 years - 7 days ago). Expires 2026-05-20.
 *     Demonstrates the 7-day CRITICAL alert window — borrower needs to
 *     re-sign this week or monitoring breaks.
 *
 *   Case 4 — Twilight Industries LLC
 *     8821 signed 2018-12-01 (past 7-year validity). Already expired.
 *     Monitoring auto-paused. Demonstrates the terminal/expired state.
 *
 *   Case 5 — Catalyst Startup Co
 *     EIN issued 2026-04-01 (newly incorporated). Monitoring enrolled
 *     WITHOUT initial pull (no returns filed yet). Demonstrates the
 *     "monitor newly-incorporated for first filing" use case.
 *
 *   Case 6 — Greenfield Holdings Inc
 *     8821 signed 2025-03-15. Has baseline pull (2026-03-01) + change
 *     re-pull (2026-05-13) showing a new TC 670 balance-due event.
 *     Demonstrates compliance change tracking across monitoring cycles.
 *
 * EINs use the IRS test/training prefix 87-* (never issued in
 * production). Signer emails use the moxie-sandbox.invalid domain.
 *
 * Idempotent: re-running rotates the API key and replaces seeded
 * entities + monitoring rows + alert state.
 *
 * Run with:
 *   npx -y dotenv-cli -e .env.local -- npx tsx scripts/provision-moxie-sandbox.ts
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

const CLIENT_NAME = 'Moxie Money Sandbox';
const CLIENT_SLUG = 'moxie-sandbox';

function generateApiKey(): string {
  const rand = crypto.randomBytes(6).toString('hex');
  return `mt_live_txn_moxie_sandbox_${rand}`;
}
function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// Compute a date N days ago from today (2026-05-13)
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}
function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
}

interface DemoEntity {
  case_label: string;
  entity_name: string;
  tid: string;
  tid_kind: 'EIN' | 'SSN';
  form_type: '1120S' | '1120' | '1065' | '1040';
  years: string[];
  signer_name: string;
  signer_email: string;
  address: { line1: string; city: string; state: string; zip: string };
  /** ISO timestamp for signature_created_at — drives 8821 expiration alerts. */
  signature_created_at: string;
  /** Monitoring config to seed in entity_monitoring table. null = skip. */
  monitoring: null | {
    frequency: 'weekly' | 'monthly' | 'quarterly' | 'custom';
    status: 'active' | 'paused' | 'cancelled' | 'expired';
    next_pull_date: string;            // YYYY-MM-DD
    last_pull_date: string | null;     // YYYY-MM-DD
    pulls_completed: number;
    notes?: string;
  };
  /** Optional synthetic transcripts — only seeded for cases that demo content. */
  transcripts: { period_ending: string; financials: Record<string, number | null>; transactions: { code: string; explanation: string; date: string; amount: string }[]; label?: string }[];
}

const DEMOS: DemoEntity[] = [
  // ─── Case 1: Healthy active monitoring ──────────────────────────────
  {
    case_label: 'Case 1 — healthy active monitoring (no alerts)',
    entity_name: 'Mountain Brew Coffee LLC',
    tid: '87-3001010',
    tid_kind: 'EIN',
    form_type: '1120S',
    years: ['2024'],
    signer_name: 'Demo Owner Brew',
    signer_email: 'demo-brew@moxie-sandbox.invalid',
    address: { line1: 'Brew Way Suite A', city: 'Boulder', state: 'CO', zip: '80301' },
    signature_created_at: daysAgo(28), // fresh — signed ~April 15, 2026
    monitoring: {
      frequency: 'quarterly',
      status: 'active',
      next_pull_date: daysFromNow(62).slice(0, 10),
      last_pull_date: daysAgo(28).slice(0, 10),
      pulls_completed: 1,
      notes: 'Quarterly post-close monitoring, fresh 8821 (~6.5 years remaining)',
    },
    transcripts: [
      {
        period_ending: '12-31-2024',
        financials: {
          grossReceipts: 1_125_000, totalIncome: 1_098_000, totalDeductions: 980_000,
          totalTax: 19_320, accountBalance: 0, accruedInterest: 0, accruedPenalty: 0,
        },
        transactions: [
          { code: '150', explanation: 'Tax return filed', date: '03-12-2025', amount: '$19,320.00' },
          { code: '610', explanation: 'Payment with return', date: '03-12-2025', amount: '-$19,320.00' },
        ],
      },
    ],
  },

  // ─── Case 2: 90-day expiration informational alert ──────────────────
  {
    case_label: 'Case 2 — 90-day 8821 expiration alert (informational)',
    entity_name: 'Sunset Logistics Inc',
    tid: '87-3002020',
    tid_kind: 'EIN',
    form_type: '1120',
    years: ['2024'],
    signer_name: 'Demo Owner Sunset',
    signer_email: 'demo-sunset@moxie-sandbox.invalid',
    address: { line1: 'Sunset Blvd Suite B', city: 'Phoenix', state: 'AZ', zip: '85003' },
    // 8821 signed ~6.75 years ago; expires in ~92 days
    signature_created_at: new Date(Date.now() - (7 * 365 - 92) * 86400_000).toISOString(),
    monitoring: {
      frequency: 'quarterly',
      status: 'active',
      next_pull_date: daysFromNow(45).slice(0, 10),
      last_pull_date: daysAgo(45).slice(0, 10),
      pulls_completed: 27,
      notes: '8821 expires in ~92 days — collect fresh signature this quarter',
    },
    transcripts: [],
  },

  // ─── Case 3: 7-day CRITICAL alert ───────────────────────────────────
  {
    case_label: 'Case 3 — 7-day CRITICAL 8821 expiration alert',
    entity_name: 'Beacon Wholesale Co',
    tid: '87-3003030',
    tid_kind: 'EIN',
    form_type: '1120',
    years: ['2024'],
    signer_name: 'Demo Owner Beacon',
    signer_email: 'demo-beacon@moxie-sandbox.invalid',
    address: { line1: 'Beacon Ln Suite C', city: 'Atlanta', state: 'GA', zip: '30303' },
    // 8821 signed ~7 years - 7 days ago; expires in 7 days exactly
    signature_created_at: new Date(Date.now() - (7 * 365 - 7) * 86400_000).toISOString(),
    monitoring: {
      frequency: 'monthly',
      status: 'active',
      next_pull_date: daysFromNow(15).slice(0, 10),
      last_pull_date: daysAgo(15).slice(0, 10),
      pulls_completed: 78,
      notes: '⚠ 8821 expires THIS WEEK — re-sign required or monitoring will fail',
    },
    transcripts: [],
  },

  // ─── Case 4: Already expired ─────────────────────────────────────────
  {
    case_label: 'Case 4 — 8821 EXPIRED, monitoring auto-paused',
    entity_name: 'Twilight Industries LLC',
    tid: '87-3004040',
    tid_kind: 'EIN',
    form_type: '1065',
    years: ['2023'],
    signer_name: 'Demo Owner Twilight',
    signer_email: 'demo-twilight@moxie-sandbox.invalid',
    address: { line1: 'Twilight Ave Suite D', city: 'Portland', state: 'OR', zip: '97205' },
    // 8821 signed > 7 years ago; expired ~5 days ago
    signature_created_at: new Date(Date.now() - (7 * 365 + 5) * 86400_000).toISOString(),
    monitoring: {
      frequency: 'quarterly',
      status: 'paused',
      next_pull_date: daysFromNow(60).slice(0, 10),
      last_pull_date: daysAgo(120).slice(0, 10),
      pulls_completed: 28,
      notes: 'Auto-paused on 8821 expiration; resume requires fresh signature',
    },
    transcripts: [],
  },

  // ─── Case 5: Newly incorporated, monitoring WITHOUT initial pull ────
  {
    case_label: 'Case 5 — newly incorporated, monitoring enrolled without initial pull',
    entity_name: 'Catalyst Startup Co',
    tid: '87-3005050',
    tid_kind: 'EIN',
    form_type: '1120S',
    years: ['2026'], // first year still in progress
    signer_name: 'Demo Owner Catalyst',
    signer_email: 'demo-catalyst@moxie-sandbox.invalid',
    address: { line1: 'Innovation Way Suite E', city: 'Austin', state: 'TX', zip: '78704' },
    signature_created_at: daysAgo(15), // signed at incorporation
    monitoring: {
      frequency: 'quarterly',
      status: 'active',
      next_pull_date: daysFromNow(90).slice(0, 10), // first pull scheduled for Q1 2027 filing window
      last_pull_date: null, // no pulls yet — entity hasn't filed anything
      pulls_completed: 0,
      notes: 'Newly-incorporated EIN (issued 2026-04-01); waiting for first filing',
    },
    transcripts: [], // no transcripts — entity hasn't filed yet
  },

  // ─── Case 6: Compliance change tracking demo ────────────────────────
  {
    case_label: 'Case 6 — compliance change tracking (baseline + re-pull diff)',
    entity_name: 'Greenfield Holdings Inc',
    tid: '87-3006060',
    tid_kind: 'EIN',
    form_type: '1120',
    years: ['2024'],
    signer_name: 'Demo Owner Greenfield',
    signer_email: 'demo-greenfield@moxie-sandbox.invalid',
    address: { line1: 'Greenfield Pkwy Suite F', city: 'Nashville', state: 'TN', zip: '37204' },
    signature_created_at: daysAgo(425), // ~14 months ago
    monitoring: {
      frequency: 'quarterly',
      status: 'active',
      next_pull_date: daysFromNow(60).slice(0, 10),
      last_pull_date: daysAgo(0).slice(0, 10),
      pulls_completed: 5,
      notes: 'Baseline 2026-03 was clean; re-pull 2026-05 surfaced TC 670 balance-due',
    },
    transcripts: [
      // Baseline pull (taken March 2026 — clean)
      {
        period_ending: '12-31-2024',
        label: 'baseline',
        financials: {
          grossReceipts: 4_280_000, totalIncome: 4_215_000, totalDeductions: 3_870_000,
          totalTax: 72_450, accountBalance: 0, accruedInterest: 0, accruedPenalty: 0,
        },
        transactions: [
          { code: '150', explanation: 'Tax return filed', date: '03-15-2025', amount: '$72,450.00' },
          { code: '610', explanation: 'Payment with return', date: '03-15-2025', amount: '-$72,450.00' },
        ],
      },
      // Re-pull (today — same period, but TC 670 balance-due appeared)
      {
        period_ending: '12-31-2024',
        label: 'change',
        financials: {
          grossReceipts: 4_280_000, totalIncome: 4_215_000, totalDeductions: 3_870_000,
          totalTax: 72_450, accountBalance: 8_412.65, accruedInterest: 247.18,
          accruedPenalty: 421.30, accountBalancePlusAccruals: 9_081.13,
        },
        transactions: [
          { code: '150', explanation: 'Tax return filed', date: '03-15-2025', amount: '$72,450.00' },
          { code: '610', explanation: 'Payment with return', date: '03-15-2025', amount: '-$72,450.00' },
          { code: '290', explanation: 'Additional tax assessed by examination', date: '04-22-2026', amount: '$8,412.65' },
          { code: '196', explanation: 'Interest assessed', date: '04-22-2026', amount: '$247.18' },
          { code: '276', explanation: 'Failure-to-pay penalty', date: '04-22-2026', amount: '$421.30' },
        ],
      },
    ],
  },
];

function renderTranscriptHtml(d: DemoEntity, t: DemoEntity['transcripts'][number]): string {
  const taxYear = t.period_ending.split('-')[2];
  const fmtMoney = (n: number | null | undefined) => n === null || n === undefined ? '$0.00' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const txRows = t.transactions.map(tx => `${tx.code}  ${tx.explanation}  ${tx.date}  ${tx.amount}`).join('\n');

  return `<!DOCTYPE html>
<html><head><title>Record of Account — ${d.entity_name}${t.label ? ` (${t.label})` : ''}</title></head><body>
<h1>This Product Contains Sensitive Taxpayer Data — DEMO/SYNTHETIC</h1>
<p style="background:#fffbe6;border:1px solid #fcd34d;padding:8px;">SANDBOX: Synthetic data for Moxie Money integration testing. Not a real IRS transcript. EINs in the 87-3xxxxxx range are fabricated.${t.label ? ` Pull label: ${t.label}.` : ''}</p>
<div class="item-container"><dt class="item-label">Form Number:</dt><dd class="item-value">${d.form_type}</dd></div>
<div class="item-container"><dt class="item-label">Taxpayer Identification Number:</dt><dd class="item-value">${d.tid}</dd></div>
<div class="item-container"><dt class="item-label">Report for Tax Period Ending:</dt><dd class="item-value">${t.period_ending}</dd></div>
<div class="item-container"><dt class="item-label">Date of Issue:</dt><dd class="item-value">05-13-2026</dd></div>
<h2>Taxpayer</h2>
<table><tr><td class="monospace" align="left">${d.entity_name}</td></tr>
<tr><td>${d.address.line1}</td></tr>
<tr><td>${d.address.city}, ${d.address.state} ${d.address.zip}</td></tr></table>
<h2>Account Summary (Tax Year ${taxYear})</h2>
<pre>
${t.financials.grossReceipts !== null && t.financials.grossReceipts !== undefined ? `GROSS RECEIPTS:                ${fmtMoney(t.financials.grossReceipts as number)}\n` : ''}TOTAL INCOME:                  ${fmtMoney(t.financials.totalIncome as number | null)}
TOTAL DEDUCTIONS:              ${fmtMoney(t.financials.totalDeductions as number | null)}
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
  console.log(`\n=== Provisioning Moxie Money Sandbox ===\n`);
  const apiKey = generateApiKey();
  const apiKeyHash = sha256Hex(apiKey);

  const { data: existing } = await sb.from('clients').select('id, name').eq('slug', CLIENT_SLUG).maybeSingle() as { data: any };
  let clientId: string;
  if (existing) {
    console.log(`✓ Found existing client ${existing.name} (${existing.id}) — rotating API key`);
    const { error } = await sb.from('clients').update({
      api_key: apiKey, api_key_hash: apiKeyHash,
    } as any).eq('id', existing.id);
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    clientId = existing.id;
  } else {
    const { data: created, error } = await sb.from('clients').insert({
      name: CLIENT_NAME, slug: CLIENT_SLUG, domain: 'moxie-sandbox.invalid',
      api_key: apiKey, api_key_hash: apiKeyHash, free_trial: true,
      billing_model: 'per_tin', billing_payment_method: null,
      monitoring_default_enabled: true, // Moxie's whole pitch is monitoring
      intake_methods: ['api', 'csv'],
      billing_ap_email: 'demo-billing@moxie-sandbox.invalid',
    } as any).select('id').single() as { data: { id: string } | null; error: any };
    if (error || !created) { console.error(`✗ ${error?.message}`); process.exit(1); }
    clientId = created.id;
    console.log(`✓ Created Moxie Money Sandbox client (${clientId})`);
  }

  // Wipe prior sandbox state — entity_monitoring rows cascade-delete via entity FK
  const { data: priorReqs } = await sb.from('requests').select('id').eq('client_id', clientId);
  for (const r of (priorReqs || [])) {
    const { data: priorEnts } = await sb.from('request_entities').select('id').eq('request_id', r.id);
    for (const e of (priorEnts || [])) {
      await sb.from('entity_monitoring' as any).delete().eq('entity_id', e.id);
    }
    await sb.from('request_entities').delete().eq('request_id', r.id);
    await sb.from('requests').delete().eq('id', r.id);
  }
  console.log(`✓ Cleared ${priorReqs?.length || 0} prior sandbox request(s)`);

  // requested_by FK lookup
  let requestedBy: string | null = null;
  const { data: matt } = await sb.from('profiles').select('id').eq('email', 'matt@moderntax.io').maybeSingle() as { data: { id: string } | null };
  if (matt) requestedBy = matt.id;
  else {
    const { data: anyProfile } = await sb.from('profiles').select('id').limit(1).maybeSingle() as { data: { id: string } | null };
    if (anyProfile) requestedBy = anyProfile.id;
  }
  if (!requestedBy) { console.error(`✗ No profiles found.`); process.exit(1); }

  const { data: req, error: reqErr } = await sb.from('requests').insert({
    client_id: clientId, requested_by: requestedBy,
    loan_number: 'MOXIE-SANDBOX-001', status: 'completed',
    completed_at: new Date().toISOString(),
    intake_method: 'api', product_type: 'transcript',
    external_request_token: crypto.randomBytes(16).toString('hex'),
    notes: 'Moxie Money sandbox — synthetic data only, no real customer info.',
  } as any).select('id').single() as { data: { id: string } | null; error: any };
  if (reqErr || !req) { console.error(`✗ ${reqErr?.message}`); process.exit(1); }
  console.log(`✓ Created sandbox request (${req.id})`);

  const seeded: { case_label: string; name: string; tid: string; tidKind: string; id: string; sigDays: number; monitoringStatus: string }[] = [];

  for (const d of DEMOS) {
    const sigDate = new Date(d.signature_created_at);
    const sigDays = Math.floor((Date.now() - sigDate.getTime()) / 86400_000);

    const { data: ent, error: entErr } = await sb.from('request_entities').insert({
      request_id: req.id,
      entity_name: d.entity_name, tid: d.tid, tid_kind: d.tid_kind,
      form_type: d.form_type, years: d.years,
      signer_first_name: d.signer_name.split(' ')[0],
      signer_last_name: d.signer_name.split(' ').slice(1).join(' '),
      signer_email: d.signer_email,
      address: d.address.line1, city: d.address.city,
      state: d.address.state, zip_code: d.address.zip,
      status: 'completed', completed_at: new Date().toISOString(),
      signed_8821_url: `moxie-sandbox/demo-8821-${d.tid.replace(/-/g, '')}.pdf`,
      signature_id: `SANDBOX-${d.tid.replace(/-/g, '')}`,
      signature_created_at: d.signature_created_at,
    } as any).select('id').single() as { data: { id: string } | null; error: any };
    if (entErr || !ent) { console.error(`✗ entity ${d.entity_name}: ${entErr?.message}`); continue; }
    seeded.push({ case_label: d.case_label, name: d.entity_name, tid: d.tid, tidKind: d.tid_kind, id: ent.id, sigDays, monitoringStatus: d.monitoring?.status || 'none' });

    // Upload synthetic transcripts (only the cases that have them)
    const htmlPaths: string[] = [];
    for (const t of d.transcripts) {
      const html = renderTranscriptHtml(d, t);
      const labelSuffix = t.label ? `-${t.label}` : '';
      const filename = `${Date.now()}-${d.entity_name.replace(/[^a-zA-Z0-9]/g, '_')}-${d.form_type}-${t.period_ending.split('-')[2]}${labelSuffix}.html`;
      const storagePath = `transcripts/${ent.id}/${filename}`;
      const { error: upErr } = await sb.storage.from('uploads').upload(storagePath, Buffer.from(html, 'utf-8'), {
        contentType: 'text/html', upsert: true,
      });
      if (upErr) { console.error(`✗ upload ${filename}: ${upErr.message}`); continue; }
      htmlPaths.push(storagePath);
      // Tiny stagger so consecutive uploads don't share a millisecond
      await new Promise(r => setTimeout(r, 5));
    }
    if (htmlPaths.length) {
      await sb.from('request_entities').update({
        transcript_html_urls: htmlPaths, transcript_urls: htmlPaths,
      }).eq('id', ent.id);
    }

    // Seed entity_monitoring row if defined for this case
    if (d.monitoring) {
      const { error: monErr } = await sb.from('entity_monitoring' as any).insert({
        entity_id: ent.id, request_id: req.id, client_id: clientId,
        enrolled_by: requestedBy,
        frequency: d.monitoring.frequency,
        next_pull_date: d.monitoring.next_pull_date,
        last_pull_date: d.monitoring.last_pull_date,
        status: d.monitoring.status,
        total_pulls_completed: d.monitoring.pulls_completed,
        latest_summary: d.monitoring.notes || null,
        latest_summary_at: d.monitoring.notes ? new Date().toISOString() : null,
      });
      if (monErr) console.error(`  ⚠ monitoring row failed: ${monErr.message}`);
    }

    console.log(`✓ ${d.entity_name.padEnd(30)} (8821 age: ${String(sigDays).padStart(5)}d, monitoring: ${d.monitoring?.status || '—'})`);
  }

  // ─── Print credentials ───────────────────────────────────────────────
  console.log(`\n\n${'═'.repeat(80)}`);
  console.log(`MOXIE SANDBOX READY — credentials below (printed ONCE)`);
  console.log(`${'═'.repeat(80)}\n`);
  console.log(`Client:    ${CLIENT_NAME}`);
  console.log(`Client ID: ${clientId}\n`);
  console.log(`x-api-key header:`);
  console.log(`  ${apiKey}\n`);
  console.log(`Seeded entities, grouped by demo case:\n`);
  for (const e of seeded) {
    console.log(`  ${e.case_label}`);
    console.log(`    ${e.tidKind} ${e.tid} ${e.name.padEnd(28)} → ${e.id}`);
    console.log(`    8821 age: ${e.sigDays} days · monitoring: ${e.monitoringStatus}\n`);
  }

  // Demo curls
  const sunset = seeded.find(s => s.name.startsWith('Sunset'));
  const beacon = seeded.find(s => s.name.startsWith('Beacon'));
  const greenfield = seeded.find(s => s.name.startsWith('Greenfield'));

  console.log(`Quick tests:\n`);
  if (beacon) {
    console.log(`  # Case 3 — fetch the entity facing CRITICAL 7-day 8821 expiration`);
    console.log(`  curl -H "x-api-key: ${apiKey}" \\`);
    console.log(`    https://portal.moderntax.io/api/v1/transcripts/${beacon.id}/structured | jq '.entity'`);
    console.log();
  }
  if (greenfield) {
    console.log(`  # Case 6 — see the change-tracked compliance state (baseline + re-pull)`);
    console.log(`  curl -H "x-api-key: ${apiKey}" \\`);
    console.log(`    https://portal.moderntax.io/api/v1/transcripts/${greenfield.id}/structured | jq '.compliance'`);
    console.log();
  }
  console.log(`  # Trigger the 8821-expiration-alert cron in dry-run mode against this sandbox`);
  console.log(`  # (requires CRON_SECRET; reach out to Matt for a sandbox-scoped key)\n`);

  console.log(`${'═'.repeat(80)}\n`);
}
