/**
 * POST /api/v1/transcripts/[entityId]/cross-reference
 *
 * Vine reseller endpoint #2 — compares self-reported financial figures
 * (from the borrower's loan application) against IRS-filed figures from
 * the most recent transcript on file. Returns a per-field diff so Vine
 * can flag misstatements in their spreading review UI without bouncing
 * to a separate page.
 *
 * Driver: Vine asked for "cross-reference self-reported vs IRS" as one
 * of their three core use cases. This endpoint solves that without
 * requiring them to call the structured-data endpoint AND do their own
 * comparison logic.
 *
 * Auth: x-api-key (same scheme as the structured endpoint).
 *
 * Request body:
 *   {
 *     tax_year: "2023",                // required — which filing to compare against
 *     self_reported: {                  // any subset of the supported fields
 *       gross_receipts?: number,
 *       total_income?: number,
 *       total_deductions?: number,
 *       total_tax?: number,
 *       agi?: number,
 *     }
 *   }
 *
 * Response:
 *   {
 *     tax_year, form,
 *     filed: true | false,
 *     diffs: [{
 *       field, irs_filed, self_reported,
 *       delta_absolute, delta_pct,
 *       match: true | false,
 *       severity: 'MATCH' | 'MINOR' | 'MATERIAL'
 *     }],
 *     overall_match: bool,
 *     summary: "..."
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sha256Hex, safeEqual } from '@/lib/auth-util';
import { screenTranscriptHtml, parseTranscriptMetadata } from '@/lib/compliance-screening';
import { extractIncomeSnapshot } from '@/lib/income-reconciliation';

export const maxDuration = 60;

const SUPPORTED_FIELDS = ['gross_receipts', 'total_income', 'total_deductions', 'total_tax', 'agi'] as const;
type SupportedField = typeof SUPPORTED_FIELDS[number];

interface PageProps {
  params: Promise<{ entityId: string }>;
}

export async function POST(request: NextRequest, { params }: PageProps) {
  const { entityId } = await params;

  // Auth
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey) return NextResponse.json({ error: 'Missing x-api-key header' }, { status: 401 });
  const sb = createAdminClient();
  const presentedHash = sha256Hex(apiKey);
  const { data: client } = await sb
    .from('clients').select('id, api_key_hash').eq('api_key_hash', presentedHash).single() as { data: any };
  if (!client || !safeEqual(client.api_key_hash, presentedHash)) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  // Parse body
  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const taxYear = String(body?.tax_year || '').trim();
  const selfReported = body?.self_reported || {};
  if (!taxYear || !/^20\d{2}$/.test(taxYear)) {
    return NextResponse.json({ error: 'tax_year required (YYYY format, e.g. "2023")' }, { status: 400 });
  }
  if (!selfReported || typeof selfReported !== 'object' || Array.isArray(selfReported)) {
    return NextResponse.json({ error: 'self_reported object required' }, { status: 400 });
  }
  const submittedFields = Object.keys(selfReported).filter(k => (SUPPORTED_FIELDS as readonly string[]).includes(k)) as SupportedField[];
  if (submittedFields.length === 0) {
    return NextResponse.json({ error: `self_reported must include at least one of: ${SUPPORTED_FIELDS.join(', ')}` }, { status: 400 });
  }

  // Lookup entity + ownership check
  const { data: entity } = await sb
    .from('request_entities')
    .select('id, entity_name, tid, form_type, transcript_urls, transcript_html_urls, requests!inner(client_id)')
    .eq('id', entityId)
    .single() as { data: any };
  if (!entity || entity.requests?.client_id !== client.id) {
    return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
  }

  // Find the transcript for this tax year
  const urls: string[] = Array.from(new Set([
    ...(entity.transcript_urls || []),
    ...(entity.transcript_html_urls || []),
  ])).filter((u: string) => u.endsWith('.html')) as string[];

  let matchedTranscript: { html: string; source: string; periodEnding: string | null; form: string } | null = null;
  for (const u of urls) {
    const { data: file } = await sb.storage.from('uploads').download(u);
    if (!file) continue;
    const html = Buffer.from(await file.arrayBuffer()).toString('utf8');
    const periodMatch = html.match(/Report for Tax Period Ending:?[\s\S]{0,200}?<dd[^>]*>([0-9-]+)<\/dd>/i);
    const periodEnding = periodMatch?.[1] || null;
    const transcriptYear = periodEnding?.split('-')[2] || '';
    if (transcriptYear === taxYear) {
      const meta = parseTranscriptMetadata(html);
      matchedTranscript = {
        html,
        source: u.split('/').pop() || u,
        periodEnding,
        form: meta.formType || entity.form_type,
      };
      break;
    }
  }

  if (!matchedTranscript) {
    return NextResponse.json({
      tax_year: taxYear,
      filed: false,
      summary: `No transcript on file for tax year ${taxYear}. Cannot cross-reference.`,
      diffs: [],
      overall_match: false,
    }, { status: 200 });
  }

  // Extract IRS-filed values
  const screen = screenTranscriptHtml(matchedTranscript.html);
  const incomeSnap = extractIncomeSnapshot(matchedTranscript.html, taxYear, matchedTranscript.source);
  const irs: Record<SupportedField, number | null> = {
    gross_receipts: screen.financials.grossReceipts,
    total_income: screen.financials.totalIncome,
    total_deductions: screen.financials.totalDeductions,
    total_tax: screen.financials.totalTax,
    agi: incomeSnap?.agi ?? null,
  };

  // Build the diffs
  const diffs = submittedFields.map((f) => {
    const irsVal = irs[f];
    const selfVal = typeof selfReported[f] === 'number' ? selfReported[f] : null;
    let deltaAbsolute: number | null = null;
    let deltaPct: number | null = null;
    let match = false;
    let severity: 'MATCH' | 'MINOR' | 'MATERIAL' = 'MATCH';

    if (irsVal !== null && selfVal !== null) {
      deltaAbsolute = selfVal - irsVal;
      deltaPct = irsVal !== 0 ? deltaAbsolute / irsVal : null;
      const absPct = deltaPct !== null ? Math.abs(deltaPct) : 0;
      if (absPct <= 0.01) {
        match = true;
        severity = 'MATCH';
      } else if (absPct <= 0.05) {
        severity = 'MINOR';
      } else {
        severity = 'MATERIAL';
      }
    }

    return {
      field: f,
      irs_filed: irsVal,
      self_reported: selfVal,
      delta_absolute: deltaAbsolute,
      delta_pct: deltaPct,
      match,
      severity,
    };
  });

  const allMatch = diffs.every(d => d.match || d.irs_filed === null);
  const materialFlags = diffs.filter(d => d.severity === 'MATERIAL');
  const summary = allMatch
    ? `All ${submittedFields.length} submitted field${submittedFields.length === 1 ? '' : 's'} match the IRS-filed return for tax year ${taxYear} (within 1% tolerance).`
    : materialFlags.length > 0
      ? `Material misstatement detected — ${materialFlags.length} field${materialFlags.length === 1 ? '' : 's'} differs by >5%: ${materialFlags.map(d => `${d.field} (Δ${(d.delta_pct! * 100).toFixed(1)}%)`).join(', ')}.`
      : `Minor variance — ${diffs.filter(d => d.severity === 'MINOR').length} field(s) differ by 1-5%. Worth verifying.`;

  return NextResponse.json({
    tax_year: taxYear,
    form: matchedTranscript.form,
    period_ending: matchedTranscript.periodEnding,
    filed: !screen.isBlank,
    transcript_source: matchedTranscript.source,
    diffs,
    overall_match: allMatch,
    summary,
  });
}
