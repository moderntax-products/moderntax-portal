/**
 * Loan-Package Consolidation Report generator.
 *
 * Driver: 2026-05-28 Matt -- the SKU was sold without a deliverable. This
 * generates a single PDF (and an Excel companion when invoked from a
 * server that can write files) that an underwriter can read end-to-end
 * for a multi-entity SBA loan.
 *
 * Output shape (PDF):
 *   - Cover: loan number, client, processor, date generated, entity
 *     count + aggregate exposure summary
 *   - For each completed entity:
 *     • Entity name, form type, TIN (last-4 masked), years pulled
 *     • Filing status summary (filed / no record found / pending) per
 *       year
 *     • Civil-penalty + balance-due flags surfaced from gross_receipts
 *     • Notes on no-record-found years (Cal Statewide's 3-year rule
 *       etc. shows up here as context)
 *   - Aggregate footer: total exposure across the loan, count of flags
 *     by category, recommended underwriter next-step
 *
 * The generator is intentionally tolerant of partial data -- when a field
 * is missing it emits an "n/a" cell rather than failing. That keeps it
 * useful for the "free admin demo" path Matt wants today even when the
 * underlying entities aren't yet fully completed.
 *
 * Pure function: takes a request + entities array, returns a Buffer.
 * No DB lookups inside; caller is responsible for fetching the data.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export interface ConsolidationEntity {
  id: string;
  entity_name: string;
  tid: string | null;
  tid_kind: string | null;
  form_type: string | null;
  years: (string | number)[] | null;
  status: string;
  completed_at: string | null;
  signer_first_name: string | null;
  signer_last_name: string | null;
  gross_receipts: any;
  transcript_urls: string[] | null;
}

export interface ConsolidationInput {
  requestId: string;
  loanNumber: string | null;
  clientName: string;
  processorName: string;
  generatedAt: string;
  entities: ConsolidationEntity[];
}

function maskTid(t: string | null, kind: string | null): string {
  if (!t) return 'n/a';
  const digits = t.replace(/\D/g, '');
  if (digits.length < 4) return t;
  const last4 = digits.slice(-4);
  if (kind === 'SSN' || kind === 'ITIN') return `***-**-${last4}`;
  return `**-***${last4}`;
}

function summarizeYears(years: (string | number)[] | null): string {
  if (!years || years.length === 0) return 'n/a';
  const nums = years.map((y) => parseInt(String(y), 10)).filter(Number.isFinite);
  if (nums.length === 0) return years.join(', ');
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const contiguous = sorted.every((y, i) => i === 0 || y === sorted[i - 1] + 1);
  return contiguous && sorted.length > 1 ? `${sorted[0]}-${sorted[sorted.length - 1]}` : sorted.join(', ');
}

function describeStatus(entity: ConsolidationEntity): string {
  switch (entity.status) {
    case 'completed': return 'Completed';
    case '8821_signed': return '8821 signed · awaiting IRS pull';
    case 'irs_queue': return 'In IRS queue';
    case 'processing': return 'Processing';
    case '8821_sent': return 'Awaiting borrower signature';
    case 'pending': return 'Pending intake';
    case 'failed': return 'Failed';
    default: return entity.status || 'Unknown';
  }
}

function extractFlags(entity: ConsolidationEntity): {
  noRecordYears: string[];
  civilPenalties: boolean;
  unfiledReturns: boolean;
  balanceDue: number | null;
  notes: string[];
} {
  const gr = entity.gross_receipts || {};
  const compliance = gr.compliance || {};
  const flags = Array.isArray(compliance.flags) ? compliance.flags : [];
  const noRecordYears: string[] = [];
  let civilPenalties = false;
  let unfiledReturns = false;
  let balanceDue: number | null = null;
  const notes: string[] = [];
  for (const f of flags) {
    const msg = String(f.message || '');
    const sev = String(f.severity || '').toUpperCase();
    if (/no record found/i.test(msg)) {
      const y = msg.match(/\b(20\d{2})\b/);
      if (y) noRecordYears.push(y[1]);
    }
    if (/civil penalt/i.test(msg)) civilPenalties = true;
    if (/unfiled|not filed/i.test(msg)) unfiledReturns = true;
    if (sev === 'CRITICAL' || sev === 'WARNING') notes.push(`[${sev}] ${msg}`);
  }
  if (typeof gr?.financials?.accountBalance === 'number') {
    balanceDue = gr.financials.accountBalance;
  } else if (typeof compliance?.financials?.accountBalance === 'number') {
    balanceDue = compliance.financials.accountBalance;
  }
  return { noRecordYears, civilPenalties, unfiledReturns, balanceDue, notes };
}

export async function generateConsolidationReportPdf(input: ConsolidationInput): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const navy = rgb(0.1, 0.16, 0.29); // mt-dark equivalent
  const accent = rgb(0.0, 0.77, 0.55); // mt-green
  const muted = rgb(0.45, 0.45, 0.5);
  const danger = rgb(0.86, 0.15, 0.15);
  const warning = rgb(0.85, 0.55, 0.05);

  const PAGE_W = 612;
  const PAGE_H = 792;
  const MARGIN = 50;
  const LINE = 14;

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const drawText = (text: string, opts: { x?: number; size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; max?: number } = {}) => {
    const size = opts.size ?? 10;
    const x = opts.x ?? MARGIN;
    const usedFont = opts.bold ? fontBold : font;
    let line = text;
    if (opts.max && opts.max > 0) {
      // crude truncation -- pdf-lib has no native wrap
      while (usedFont.widthOfTextAtSize(line, size) > opts.max && line.length > 1) {
        line = line.slice(0, -2) + '…';
      }
    }
    page.drawText(line, { x, y, size, font: usedFont, color: opts.color ?? navy });
    y -= size + 4;
  };

  const ensureSpace = (rowsNeeded: number) => {
    if (y - rowsNeeded * LINE < MARGIN) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };

  // -------- Cover header --------
  drawText('Loan-Package Consolidation Report', { size: 20, bold: true });
  y -= 6;
  drawText(`${input.clientName} · loan ${input.loanNumber || input.requestId.slice(0, 8)}`, { size: 12, color: muted });
  drawText(`Prepared for the underwriter · ${input.entities.length} entities on this loan`, { size: 10, color: muted });
  drawText(`Submitted by ${input.processorName} · Generated ${new Date(input.generatedAt).toLocaleString()}`, { size: 9, color: muted });
  y -= 6;

  // -------- Aggregate roll-up --------
  let totalNoRecord = 0;
  let totalCivilPen = 0;
  let totalUnfiled = 0;
  let totalBalanceDue = 0;
  let completed = 0;
  let pending = 0;
  for (const e of input.entities) {
    const flags = extractFlags(e);
    totalNoRecord += flags.noRecordYears.length;
    if (flags.civilPenalties) totalCivilPen += 1;
    if (flags.unfiledReturns) totalUnfiled += 1;
    if (typeof flags.balanceDue === 'number') totalBalanceDue += Math.max(0, flags.balanceDue);
    if (e.status === 'completed') completed += 1;
    else pending += 1;
  }

  drawText('Roll-up across this loan', { size: 12, bold: true, color: accent });
  drawText(`  · ${completed} of ${input.entities.length} entities completed`, { size: 10 });
  drawText(`  · ${totalNoRecord} no-record-found year${totalNoRecord === 1 ? '' : 's'} across all entities`, { size: 10, color: totalNoRecord > 0 ? warning : muted });
  drawText(`  · ${totalCivilPen} entit${totalCivilPen === 1 ? 'y' : 'ies'} flagged with civil penalties`, { size: 10, color: totalCivilPen > 0 ? danger : muted });
  drawText(`  · ${totalUnfiled} entit${totalUnfiled === 1 ? 'y' : 'ies'} with unfiled returns`, { size: 10, color: totalUnfiled > 0 ? danger : muted });
  drawText(`  · Aggregate balance-due exposure: $${totalBalanceDue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, { size: 10, color: totalBalanceDue > 0 ? warning : muted });
  if (pending > 0) {
    drawText(`  · ${pending} entit${pending === 1 ? 'y' : 'ies'} not yet completed -- report will refresh on completion`, { size: 9, color: muted });
  }
  y -= 8;

  // -------- Per-entity sections --------
  drawText('Per-entity findings', { size: 12, bold: true, color: accent });
  y -= 4;

  for (const e of input.entities) {
    ensureSpace(8);
    const flags = extractFlags(e);
    const yearsStr = summarizeYears(e.years);
    const signer = [e.signer_first_name, e.signer_last_name].filter(Boolean).join(' ') || 'n/a';

    drawText(`${e.entity_name}`, { size: 11, bold: true });
    drawText(`  Form ${e.form_type || 'n/a'} · TIN ${maskTid(e.tid, e.tid_kind)} · Years ${yearsStr} · Status: ${describeStatus(e)}`, { size: 9, color: muted });
    drawText(`  Signer: ${signer} · Transcripts on file: ${e.transcript_urls?.length || 0}`, { size: 9, color: muted });

    if (flags.noRecordYears.length > 0) {
      drawText(`  WARN:No record found for: ${[...new Set(flags.noRecordYears)].sort().join(', ')}`, { size: 9, color: warning });
    }
    if (flags.civilPenalties) {
      drawText(`  FLAG:Civil penalties flagged on this entity`, { size: 9, color: danger });
    }
    if (flags.unfiledReturns) {
      drawText(`  FLAG:Unfiled returns flagged on this entity`, { size: 9, color: danger });
    }
    if (typeof flags.balanceDue === 'number' && flags.balanceDue > 0) {
      drawText(`  WARN:Balance due: $${flags.balanceDue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, { size: 9, color: warning });
    }
    if (flags.notes.length > 0) {
      for (const n of flags.notes.slice(0, 3)) {
        ensureSpace(1);
        drawText(`  • ${n}`, { size: 8, color: muted, max: PAGE_W - MARGIN * 2 });
      }
      if (flags.notes.length > 3) {
        drawText(`  • +${flags.notes.length - 3} more flags -- see entity record for detail`, { size: 8, color: muted });
      }
    }
    if (flags.noRecordYears.length === 0 && !flags.civilPenalties && !flags.unfiledReturns && flags.notes.length === 0 && (flags.balanceDue == null || flags.balanceDue <= 0)) {
      drawText(`  OK:Clean -- no flags`, { size: 9, color: accent });
    }
    y -= 6;
  }

  // -------- Footer --------
  ensureSpace(4);
  y -= 6;
  drawText('Recommended underwriter next-step', { size: 11, bold: true, color: accent });
  const reco = [
    totalCivilPen > 0 || totalUnfiled > 0
      ? 'High-risk profile: confirm IRS resolution plan with borrower before final approval.'
      : totalNoRecord > 0
        ? 'Medium-risk profile: pull no-record-found years again post-close (monitoring) to confirm filing landed.'
        : 'Low-risk profile: aggregate flags are within acceptable range for SBA underwriting.',
    'Reach out to the ModernTax team if borrower provides amended returns -- we will reorder at the $29.99 reorder rate.',
  ];
  for (const r of reco) {
    ensureSpace(1);
    drawText(`  · ${r}`, { size: 9, max: PAGE_W - MARGIN * 2 });
  }

  ensureSpace(2);
  y -= 14;
  drawText('-- Generated by ModernTax Portal', { size: 8, color: muted });
  drawText('  Loan-Package Consolidation Report SKU -- see your invoice for billing detail.', { size: 8, color: muted });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
