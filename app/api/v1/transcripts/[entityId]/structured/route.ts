/**
 * GET /api/v1/transcripts/[entityId]/structured
 *
 * Vine Partnership / reseller endpoint — returns the entity's transcript
 * data as fully-structured JSON suitable for embedding into Vine's
 * spreading UI (not as PDFs or raw HTML). Each filing is broken out by
 * (form_type, tax_year, tax_period_ending) with parsed financial fields,
 * filing status, transaction-code history, and the full compliance
 * synthesis we generate for the admin UI.
 *
 * Driver: Vine's core ask (2026-05-13 review) — they need transcript
 * data integrated into their spreading platform, not just PDF delivery
 * with field-level granularity (gross receipts, COGS, filing dates,
 * entity info). Previously this data only existed inside our admin
 * compliance-status page; this endpoint exposes it via API for reseller
 * integration.
 *
 * Auth: x-api-key (same scheme as /api/intake/transcript GET — SHA256
 * hashed lookup, constant-time comparison).
 *
 * Response shape:
 *   {
 *     entity: { id, name, tin, tid_kind, form_type, ... },
 *     filings: [{
 *       form, period, tax_period_ending, filed_on,
 *       financials: { gross_receipts, total_income, total_deductions,
 *                     total_tax, account_balance, accrued_interest,
 *                     accrued_penalty, agi },
 *       transaction_codes: [{ code, explanation, date, amount }],
 *       severity, flags
 *     }],
 *     compliance: {
 *       overall_severity, headline_summary,
 *       filing_compliance: { filed, unfiled },
 *       tax_liabilities: { rows, total_balance, total_accrued },
 *       repayment_plan: { has_installment_agreement, has_offer_in_compromise,
 *                         has_currently_not_collectible, details, recommendation }
 *     },
 *     income_baseline: { ... } | null,
 *     income_snapshot: { ... } | null,
 *     transcripts_parsed_count: N,
 *     sources: [filename, ...],
 *     generated_at: ISO timestamp
 *   }
 *
 * Access: API key must belong to the client that owns the entity's
 * request (we read it through the requests → client_id join).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sha256Hex, safeEqual } from '@/lib/auth-util';
import { screenTranscriptHtml, parseTranscriptMetadata } from '@/lib/compliance-screening';
import { buildTaxLiabilityReport } from '@/lib/tax-liability-report';
import { extractIncomeSnapshot } from '@/lib/income-reconciliation';

export const maxDuration = 60;

interface PageProps {
  params: Promise<{ entityId: string }>;
}

export async function GET(request: NextRequest, { params }: PageProps) {
  const { entityId } = await params;

  // ---- Auth: x-api-key header ----
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing x-api-key header' }, { status: 401 });
  }

  const sb = createAdminClient();
  const presentedHash = sha256Hex(apiKey);

  const { data: client } = await sb
    .from('clients')
    .select('id, name, api_key_hash')
    .eq('api_key_hash', presentedHash)
    .single() as { data: { id: string; name: string; api_key_hash: string } | null };

  if (!client || !safeEqual(client.api_key_hash, presentedHash)) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  // ---- Load entity + verify client ownership ----
  const { data: entity, error: lookupErr } = await sb
    .from('request_entities')
    .select(`
      id, entity_name, tid, tid_kind, form_type, years, status,
      fiscal_year_end_month,
      transcript_urls, transcript_html_urls, completed_at, request_id,
      income_baseline, income_snapshot,
      requests!inner(client_id, loan_number)
    `)
    .eq('id', entityId)
    .single() as { data: any; error: any };

  if (lookupErr || !entity) {
    return NextResponse.json({ error: 'Entity not found', details: lookupErr?.message }, { status: 404 });
  }
  if (entity.requests?.client_id !== client.id) {
    // Don't leak existence — return 404 instead of 403 to keep enumeration cost high.
    return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
  }

  // ---- Pull all HTML transcripts ----
  const urls: string[] = Array.from(new Set([
    ...(entity.transcript_urls || []),
    ...(entity.transcript_html_urls || []),
  ])).filter((u: string) => u.endsWith('.html')) as string[];

  const transcripts: { source: string; html: string }[] = [];
  for (const u of urls) {
    const { data: file } = await sb.storage.from('uploads').download(u);
    if (!file) continue;
    const html = Buffer.from(await file.arrayBuffer()).toString('utf8');
    transcripts.push({ source: u.split('/').pop() || u, html });
  }

  // ---- Parse each transcript into a filing row ----
  const filings: any[] = [];
  for (const t of transcripts) {
    const meta = parseTranscriptMetadata(t.html);
    const screen = screenTranscriptHtml(t.html);
    const periodMatch = t.html.match(/Report for Tax Period Ending:?[\s\S]{0,200}?<dd[^>]*>([0-9-]+)<\/dd>/i);
    const periodEnding = periodMatch?.[1] || null;
    const taxYear = periodEnding?.split('-')[2] || meta.taxYear;
    const tc150 = screen.transactionCodes.find(tc => tc.code === '150');
    const filedOn = tc150?.date || null;

    // Income snapshot via the existing extractor (uses AGI for 1040s)
    const incomeSnap = extractIncomeSnapshot(t.html, taxYear || '', t.source);

    filings.push({
      form: meta.formType || entity.form_type,
      period: taxYear || 'unknown',
      tax_period_ending: periodEnding,
      filed_on: filedOn,
      transcript_source: t.source,
      financials: {
        gross_receipts: screen.financials.grossReceipts,
        total_income: screen.financials.totalIncome,
        total_deductions: screen.financials.totalDeductions,
        total_tax: screen.financials.totalTax,
        agi: incomeSnap?.agi ?? null,
        account_balance: screen.financials.accountBalance,
        accrued_interest: screen.financials.accruedInterest,
        accrued_penalty: screen.financials.accruedPenalty,
        account_balance_plus_accruals: screen.financials.accountBalancePlusAccruals,
      },
      transaction_codes: screen.transactionCodes,
      severity: screen.severity,
      flags: screen.flags,
      is_blank_or_unfiled: screen.isBlank,
    });
  }

  // ---- Build the unified compliance synthesis ----
  const report = buildTaxLiabilityReport(entity.entity_name, entity.tid, transcripts);

  return NextResponse.json({
    entity: {
      id: entity.id,
      name: entity.entity_name,
      tin: entity.tid,
      tid_kind: entity.tid_kind,
      form_type: entity.form_type,
      years: entity.years,
      // Non-calendar fiscal year end (1-11). null = calendar (12/31).
      // Consumers should use this to derive expected period_ending:
      //   fye_month=2, year=2024 → period_ending = 02-28-2025
      // Only meaningful for income-tax forms (1040/1065/1120/1120S);
      // Form 941 always uses calendar quarters.
      fiscal_year_end_month: entity.fiscal_year_end_month ?? null,
      status: entity.status,
      completed_at: entity.completed_at,
      loan_number: entity.requests?.loan_number || null,
    },
    filings: filings.sort((a, b) => {
      // Sort newest period first
      const ay = parseInt(a.period, 10) || 0;
      const by = parseInt(b.period, 10) || 0;
      return by - ay;
    }),
    compliance: {
      overall_severity: report.overallSeverity,
      headline_summary: report.headlineSummary,
      filing_compliance: report.filingCompliance,
      tax_liabilities: {
        rows: report.taxLiabilities.rows,
        total_assessed: report.taxLiabilities.totalAssessed,
        total_paid: report.taxLiabilities.totalPaid,
        total_balance: report.taxLiabilities.totalBalance,
        total_accrued: report.taxLiabilities.totalAccrued,
      },
      repayment_plan: {
        has_installment_agreement: report.repaymentPlan.hasInstallmentAgreement,
        has_offer_in_compromise: report.repaymentPlan.hasOfferInCompromise,
        has_currently_not_collectible: report.repaymentPlan.hasCurrentlyNotCollectible,
        details: report.repaymentPlan.details,
        recommendation: report.repaymentPlan.recommendation,
      },
      estimated_payments: report.estimatedPayments,
      extensions_and_amendments: report.extensionsAndAmendments,
    },
    income_baseline: entity.income_baseline || null,
    income_snapshot: entity.income_snapshot || null,
    transcripts_parsed_count: transcripts.length,
    sources: report.sources,
    generated_at: report.generatedAt,
  });
}
