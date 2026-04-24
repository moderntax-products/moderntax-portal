/**
 * Resend ClearFirm v3 financial_verification webhooks WITH actual parsed values
 *
 * Parses IRS Record of Account HTML transcripts to extract real financial data:
 * - Gross Receipts, Total Income, Total Deductions, Taxable Income
 * - Total Assets, Officer Compensation, Salary/Wages
 * - Account Balance, Accrued Interest/Penalty
 *
 * Targets: CF-cherrytech-270 (Thomas B Evers DMD PC) — all financial transcripts
 * Also resends 272, 274 with whatever financial data is available
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  buildEntityProfilePayload,
  buildFormDiscoveryPayload,
  buildRiskSignalsPayload,
  generateRecordId,
  type WebhookV3Payload,
  type AnyWebhookV3Payload,
} from '../lib/webhook-v3';

dotenv.config({ path: path.resolve(__dirname, '../.env.vercel-prod') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const REQUEST_TOKENS = [
  'CF-cherrytech-270',
  'CF-cherrytech-272',
  'CF-cherrytech-274',
];

// ---------------------------------------------------------------------------
// IRS Record of Account HTML Parser
// ---------------------------------------------------------------------------

interface ParsedFinancials {
  grossReceipts: number | null;
  totalIncome: number | null;
  totalDeductions: number | null;
  taxableIncome: number | null;
  totalAssets: number | null;
  officerCompensation: number | null;
  salaryAndWages: number | null;
  costOfGoodsSold: number | null;
  depreciation: number | null;
  rents: number | null;
  advertising: number | null;
  pensionPlans: number | null;
  otherDeductions: number | null;
  totalTax: number | null;
  accountBalance: number | null;
  accruedInterest: number | null;
  accruedPenalty: number | null;
  naicsCode: string | null;
  ordinaryIncome: number | null;
  // 941-specific
  totalTaxLiability: number | null;
  totalDeposits: number | null;
  taxableWages: number | null;
}

function parseDollar(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern);
  if (!match) return null;
  // Find the dollar amount after the label
  const afterLabel = text.slice(match.index! + match[0].length);
  const amountMatch = afterLabel.match(/\$[\d,]+\.?\d*/);
  if (!amountMatch) return null;
  return parseFloat(amountMatch[0].replace(/[$,]/g, ''));
}

function parseTranscriptHtml(html: string): ParsedFinancials {
  // Strip tags to get plain text
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');

  const dollarPattern = (label: string) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped + '[:\\s]*\\$([\\d,]+\\.?\\d*)', 'i');
    const match = text.match(regex);
    if (!match) return null;
    return parseFloat(match[1].replace(/,/g, ''));
  };

  // Extract NAICS code
  const naicsMatch = text.match(/(?:Business Activity Code|NAICS)[:\s]*(\d{6})/i);

  return {
    grossReceipts: dollarPattern('Income Gross Receipts') ?? dollarPattern('Gross Receipts'),
    totalIncome: dollarPattern('Total Income Per Computer') ?? dollarPattern('Total Income'),
    totalDeductions: dollarPattern('Total Deductions Per Computer') ?? dollarPattern('Total Deductions'),
    taxableIncome: dollarPattern('Taxable Income'),
    totalAssets: dollarPattern('Total Assets at End of Year'),
    officerCompensation: dollarPattern('Compensation of Officers'),
    salaryAndWages: dollarPattern('Salary and Wages'),
    costOfGoodsSold: dollarPattern('Cost of Goods Sold'),
    depreciation: dollarPattern('Depreciation'),
    rents: dollarPattern('Rents'),
    advertising: dollarPattern('Advertising'),
    pensionPlans: dollarPattern('Pension/Profit Share'),
    otherDeductions: dollarPattern('Other Deductions'),
    totalTax: dollarPattern('Total Tax per Return') ?? dollarPattern('Total Tax'),
    accountBalance: dollarPattern('Account balance'),
    accruedInterest: dollarPattern('Accrued interest'),
    accruedPenalty: dollarPattern('Accrued penalty'),
    naicsCode: naicsMatch?.[1] || null,
    ordinaryIncome: dollarPattern('Ordinary Income/Loss Per Computer') ?? dollarPattern('Ordinary Income'),
    // 941
    totalTaxLiability: dollarPattern('Total Tax Liability'),
    totalDeposits: dollarPattern('Total Deposits'),
    taxableWages: dollarPattern('Taxable Social Security Wages') ?? dollarPattern('Taxable Wages'),
  };
}

function buildFinancialPayloadFromParsed(
  requestToken: string,
  entity: any,
  formType: string,
  taxYear: string,
  parsed: ParsedFinancials,
  rawHtml: string
): WebhookV3Payload {
  const normalizedForm = formType.replace(/[\s-]/g, '');
  const year = parseInt(taxYear.match(/\d{4}/)?.[0] || '0', 10);
  const discriminator = `${normalizedForm}_${taxYear}`;
  const recordId = generateRecordId(entity.tid, 'financial_verification', discriminator);

  // Compute employment costs = officer comp + salary/wages + pension
  const employmentCosts = [parsed.officerCompensation, parsed.salaryAndWages, parsed.pensionPlans]
    .filter((v): v is number => v != null)
    .reduce((a, b) => a + b, 0) || null;

  const financials: Record<string, unknown> = {};

  if (parsed.grossReceipts != null) {
    financials.revenue = { min_usd: parsed.grossReceipts, max_usd: parsed.grossReceipts };
  }
  if (parsed.totalIncome != null) {
    financials.total_income = { min_usd: parsed.totalIncome, max_usd: parsed.totalIncome };
  }
  if (parsed.ordinaryIncome != null) {
    financials.net_income = { min_usd: parsed.ordinaryIncome, max_usd: parsed.ordinaryIncome };
  }
  if (parsed.totalDeductions != null) {
    financials.total_deductions = { min_usd: parsed.totalDeductions, max_usd: parsed.totalDeductions };
  }
  if (parsed.totalAssets != null) {
    financials.total_assets = { min_usd: parsed.totalAssets, max_usd: parsed.totalAssets };
  }
  if (employmentCosts) {
    financials.employment_costs = { min_usd: employmentCosts, max_usd: employmentCosts };
  }
  if (parsed.costOfGoodsSold != null) {
    financials.cost_of_goods_sold = parsed.costOfGoodsSold;
  }
  if (parsed.totalTax != null) {
    financials.total_tax = parsed.totalTax;
  }
  if (parsed.accountBalance != null) {
    financials.account_balance = parsed.accountBalance;
  }
  if (parsed.accruedInterest != null) {
    financials.accrued_interest = parsed.accruedInterest;
  }
  if (parsed.accruedPenalty != null) {
    financials.accrued_penalty = parsed.accruedPenalty;
  }

  // Line items breakdown
  const lineItems: Record<string, number> = {};
  if (parsed.officerCompensation != null) lineItems.officer_compensation = parsed.officerCompensation;
  if (parsed.salaryAndWages != null) lineItems.salary_and_wages = parsed.salaryAndWages;
  if (parsed.rents != null) lineItems.rents = parsed.rents;
  if (parsed.advertising != null) lineItems.advertising = parsed.advertising;
  if (parsed.depreciation != null) lineItems.depreciation = parsed.depreciation;
  if (parsed.pensionPlans != null) lineItems.pension_plans = parsed.pensionPlans;
  if (parsed.otherDeductions != null) lineItems.other_deductions = parsed.otherDeductions;
  if (parsed.costOfGoodsSold != null) lineItems.cost_of_goods_sold = parsed.costOfGoodsSold;

  // Count how many core fields we extracted
  const coreFields = [parsed.grossReceipts, parsed.totalIncome, parsed.totalDeductions, parsed.totalAssets, parsed.ordinaryIncome];
  const confidence = Math.round((coreFields.filter(v => v != null).length / coreFields.length) * 100) / 100;

  const entityBlock = {
    legal_name: entity.entity_name.toUpperCase(),
    submitted_name: entity.entity_name,
    ein: entity.tid,
    entity_type: deriveEntityType(formType),
    state: entity.state || null,
    address: {
      street: entity.address || null,
      city: entity.city || null,
      state: entity.state || null,
      zip_code: entity.zip_code || null,
    },
    principal: entity.signer_first_name ? {
      full_name: [entity.signer_first_name, entity.signer_last_name].filter(Boolean).join(' '),
      title: null,
    } : null,
  };

  return {
    request_token: requestToken,
    status: 'partial',
    record_id: recordId,
    record_type: 'financial_verification',
    generated_at: new Date().toISOString(),
    entity: entityBlock,
    data: {
      reporting_year: year,
      form_type: normalizedForm,
      naics_code: parsed.naicsCode,
      financials,
      line_items: Object.keys(lineItems).length > 0 ? lineItems : undefined,
      financial_verification_available: true,
      confidence,
    },
    raw_html: rawHtml,
  };
}

function buildEmploymentPayloadFromParsed(
  requestToken: string,
  entity: any,
  formType: string,
  taxYear: string,
  parsed: ParsedFinancials,
  rawHtml: string
): WebhookV3Payload {
  const normalizedForm = formType.replace(/[\s-]/g, '');
  const year = parseInt(taxYear.match(/\d{4}/)?.[0] || '0', 10);
  const quarterMatch = taxYear.match(/^(\d{2})-/);
  let quarter: string | null = null;
  if (quarterMatch) {
    const m = parseInt(quarterMatch[1], 10);
    quarter = m <= 3 ? 'Q1' : m <= 6 ? 'Q2' : m <= 9 ? 'Q3' : 'Q4';
  }

  const discriminator = `${normalizedForm}_${taxYear}`;
  const recordId = generateRecordId(entity.tid, 'employment_compliance', discriminator);

  const entityBlock = {
    legal_name: entity.entity_name.toUpperCase(),
    submitted_name: entity.entity_name,
    ein: entity.tid,
    entity_type: deriveEntityType(formType),
    state: entity.state || null,
    address: {
      street: entity.address || null,
      city: entity.city || null,
      state: entity.state || null,
      zip_code: entity.zip_code || null,
    },
    principal: entity.signer_first_name ? {
      full_name: [entity.signer_first_name, entity.signer_last_name].filter(Boolean).join(' '),
      title: null,
    } : null,
  };

  const data: Record<string, unknown> = {
    form_type: normalizedForm,
    year,
    status: (parsed.accountBalance ?? 0) > 0 ? 'balance_due' : 'current',
  };
  if (quarter) data.quarter = quarter;
  if (parsed.totalTax != null || parsed.totalTaxLiability != null) {
    const tax = parsed.totalTaxLiability ?? parsed.totalTax ?? 0;
    data.total_tax_range_usd = { min: tax, max: tax };
  }
  if (parsed.accountBalance != null) data.balance_due_usd = parsed.accountBalance;
  if (parsed.accruedInterest != null) data.accrued_interest_usd = parsed.accruedInterest;
  if (parsed.accruedPenalty != null) data.accrued_penalty_usd = parsed.accruedPenalty;
  if (parsed.taxableWages != null) data.taxable_wages_usd = parsed.taxableWages;
  if (parsed.totalDeposits != null) data.total_deposits_usd = parsed.totalDeposits;
  data.processing_notes = [];

  return {
    request_token: requestToken,
    status: 'partial',
    record_id: recordId,
    record_type: 'employment_compliance',
    generated_at: new Date().toISOString(),
    entity: entityBlock,
    data,
    raw_html: rawHtml,
  };
}

function deriveEntityType(formType: string): string | null {
  const f = formType.replace(/[\s-]/g, '').toUpperCase();
  if (f === '1120S') return 's_corporation';
  if (f === '1120') return 'corporation';
  if (f === '1065') return 'partnership';
  if (f === '1040') return 'individual';
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== ClearFirm v3 Financial Resend (with parsed values) ===\n');

  const allPayloads: Array<{
    requestId: string;
    clientId: string;
    webhookUrl: string;
    payload: AnyWebhookV3Payload;
    token: string;
  }> = [];

  for (const token of REQUEST_TOKENS) {
    console.log(`\n--- ${token} ---`);

    const { data: request } = await supabase
      .from('requests')
      .select('id, client_id, external_request_token, status')
      .eq('external_request_token', token)
      .single();

    if (!request) { console.log('  X Not found'); continue; }

    const { data: client } = await supabase
      .from('clients')
      .select('id, webhook_url, webhook_secret')
      .eq('id', request.client_id)
      .single();

    if (!client?.webhook_url) { console.log('  X No webhook'); continue; }

    const { data: entities } = await supabase
      .from('request_entities')
      .select('id, entity_name, tid, tid_kind, address, city, state, zip_code, form_type, signer_first_name, signer_last_name, gross_receipts, transcript_urls, transcript_html_urls')
      .eq('request_id', request.id) as { data: any[] | null; error: any };

    if (!entities || entities.length === 0) { console.log('  X No entities'); continue; }

    for (const entity of entities) {
      const htmlPaths = [...(entity.transcript_urls || []), ...(entity.transcript_html_urls || [])]
        .filter((u: string) => u.endsWith('.html'));

      if (htmlPaths.length === 0) {
        console.log(`  ${entity.entity_name}: no HTML files`);
        continue;
      }

      console.log(`  ${entity.entity_name}: ${htmlPaths.length} files`);

      for (const htmlPath of htmlPaths) {
        const filename = (htmlPath.split('/').pop() || '').replace(/^\d+-/, '');
        const lower = filename.toLowerCase();

        // Download HTML
        const { data: fileData } = await supabase.storage.from('uploads').download(htmlPath);
        if (!fileData) { console.log(`    X Download failed: ${filename}`); continue; }
        const rawHtml = await fileData.text();
        if (rawHtml.length < 100) { console.log(`    X Too small: ${filename}`); continue; }

        // Determine form type
        let formType = entity.form_type || '';
        if (lower.includes('entity transcript')) formType = 'BMF_ENTITY';
        else if (lower.includes('941')) formType = '941';
        else if (lower.includes('1120s') || lower.includes('1120-s')) formType = '1120S';
        else if (lower.includes('1120') && !lower.includes('1120s')) formType = '1120';
        else if (lower.includes('1065')) formType = '1065';

        const yearMatch = filename.match(/(20\d{2})/);
        const taxYear = yearMatch ? yearMatch[1] : '';

        // Parse the HTML
        const parsed = parseTranscriptHtml(rawHtml);

        if (formType === 'BMF_ENTITY') {
          // Entity profile
          const entityData = entity.gross_receipts?.entity_transcript || null;
          const ep = buildEntityProfilePayload(token, entity, entityData, rawHtml);
          console.log(`    -> entity_profile: ${filename}`);
          allPayloads.push({ requestId: request.id, clientId: client.id, webhookUrl: client.webhook_url, payload: ep, token });

          const fd = buildFormDiscoveryPayload(token, entity, entityData, rawHtml);
          if (fd) {
            console.log(`    -> form_discovery: ${filename}`);
            allPayloads.push({ requestId: request.id, clientId: client.id, webhookUrl: client.webhook_url, payload: fd, token });
          }
        } else if (['941', '940'].includes(formType)) {
          // Employment compliance with parsed values
          const payload = buildEmploymentPayloadFromParsed(token, entity, formType, taxYear, parsed, rawHtml);
          const taxVal = (payload.data as any).total_tax_range_usd;
          const bal = (payload.data as any).balance_due_usd;
          console.log(`    -> employment_compliance: ${filename} | tax=${taxVal?.min ?? 'N/A'} bal=${bal ?? 'N/A'}`);
          allPayloads.push({ requestId: request.id, clientId: client.id, webhookUrl: client.webhook_url, payload, token });
        } else {
          // Financial verification with ACTUAL parsed values
          const payload = buildFinancialPayloadFromParsed(token, entity, formType, taxYear, parsed, rawHtml);
          const fin = (payload.data as any).financials;
          const rev = fin?.revenue?.min_usd;
          const income = fin?.net_income?.min_usd;
          const assets = fin?.total_assets?.min_usd;
          const conf = (payload.data as any).confidence;
          console.log(`    -> financial_verification: ${filename} | rev=$${rev?.toLocaleString() ?? 'N/A'} income=$${income?.toLocaleString() ?? 'N/A'} assets=$${assets?.toLocaleString() ?? 'N/A'} conf=${conf}`);
          allPayloads.push({ requestId: request.id, clientId: client.id, webhookUrl: client.webhook_url, payload, token });
        }
      }
    }

    // Completion payloads
    if (request.status === 'completed') {
      // Risk signals
      for (const entity of entities) {
        const riskPayload = buildRiskSignalsPayload(token, entity, entity.gross_receipts);
        console.log(`  -> risk_signals (${entity.entity_name})`);
        allPayloads.push({ requestId: request.id, clientId: client.id, webhookUrl: client.webhook_url, payload: riskPayload, token });
      }
      // Complete signal
      const completePayload: AnyWebhookV3Payload = {
        request_token: token,
        status: 'complete',
        record_id: `mt_complete_${crypto.createHash('md5').update(token).digest('hex').slice(0, 12)}`,
        record_type: 'complete' as any,
        generated_at: new Date().toISOString(),
      };
      console.log(`  -> complete`);
      allPayloads.push({ requestId: request.id, clientId: client.id, webhookUrl: client.webhook_url, payload: completePayload, token });
    }
  }

  // Enqueue + deliver
  console.log(`\n=== Enqueuing ${allPayloads.length} deliveries ===\n`);

  const deliveryIds: string[] = [];
  for (const item of allPayloads) {
    const { data: delivery, error } = await supabase
      .from('webhook_deliveries')
      .insert({
        request_id: item.requestId,
        client_id: item.clientId,
        webhook_url: item.webhookUrl,
        payload: item.payload as any,
        status: 'pending',
        max_attempts: 5,
      })
      .select('id')
      .single();

    if (error || !delivery) { console.log(`  X Enqueue failed: ${error?.message}`); continue; }
    deliveryIds.push(delivery.id);
  }

  console.log(`Enqueued ${deliveryIds.length} deliveries\n`);
  console.log('=== Delivering ===\n');

  // Wake Render
  console.log('Waking ClearFirm...');
  try { await fetch('https://clearfirm-api.onrender.com/api/v1/webhook/moderntax', { method: 'HEAD' }); } catch {}
  await new Promise(r => setTimeout(r, 3000));

  let delivered = 0, failed = 0;

  for (const delId of deliveryIds) {
    const { data: del } = await supabase
      .from('webhook_deliveries')
      .select('id, payload, client_id, webhook_url')
      .eq('id', delId)
      .single();
    if (!del) continue;

    const payloadStr = JSON.stringify(del.payload);
    const now = new Date().toISOString();
    await supabase.from('webhook_deliveries').update({ status: 'sending' }).eq('id', del.id);

    try {
      const { data: clientInfo } = await supabase.from('clients').select('webhook_secret').eq('id', del.client_id).single();
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'ModernTax-Webhook/3.0' };
      if (clientInfo?.webhook_secret) {
        headers['X-ModernTax-Signature'] = crypto.createHmac('sha256', clientInfo.webhook_secret).update(payloadStr).digest('hex');
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const resp = await fetch(del.webhook_url, { method: 'POST', headers, body: payloadStr, signal: controller.signal });
      clearTimeout(timeout);

      if (resp.status >= 200 && resp.status < 300) {
        await supabase.from('webhook_deliveries').update({
          status: 'delivered', attempts: 1, last_attempt_at: now,
          last_status_code: resp.status, delivered_at: now, updated_at: now,
        }).eq('id', del.id);
        const p = del.payload as any;
        const payloadSize = (payloadStr.length / 1024).toFixed(1);
        console.log(`  OK ${del.id.slice(0, 8)} -> ${p.request_token} ${p.record_type || p.status} (${payloadSize}KB)`);
        delivered++;
      } else {
        const body = await resp.text().catch(() => '');
        await supabase.from('webhook_deliveries').update({
          status: 'failed', attempts: 1, last_attempt_at: now,
          last_status_code: resp.status, last_error: `HTTP ${resp.status}: ${body.slice(0, 200)}`, updated_at: now,
        }).eq('id', del.id);
        console.log(`  FAIL ${del.id.slice(0, 8)} -> HTTP ${resp.status}`);
        failed++;
      }
    } catch (err: any) {
      await supabase.from('webhook_deliveries').update({
        status: 'failed', attempts: 1, last_attempt_at: now, last_error: err.message, updated_at: now,
      }).eq('id', del.id);
      console.log(`  FAIL ${del.id.slice(0, 8)} -> ${err.message}`);
      failed++;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Delivered: ${delivered}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${deliveryIds.length}`);
}

main().catch(console.error);
