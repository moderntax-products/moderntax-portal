/**
 * SBA Cash-Flow Analysis Pack PDF Generator
 *
 * Produces a lender-ready cash-flow worksheet from an entity's transcript-
 * derived financials. The output mirrors the layout SBA underwriters use
 * during Phase 2 (Days 30-60) — gross receipts, total income, deductions,
 * net income, plus add-back lines (depreciation / interest / owner comp /
 * non-recurring) that the processor fills in to arrive at adjusted cash flow.
 *
 * Why this exists:
 * Today the underwriter opens each year's transcript HTML, transcribes line
 * items into Excel by hand, and computes cash flow. ~30-60 min per loan.
 * This module reads `entity.gross_receipts` (already populated by the
 * compliance screener and historical Centerstone migration) and produces
 * the same worksheet in a few seconds, billed at $49.99/loan as an SBA
 * "Cash-Flow Analysis Pack" SKU.
 *
 * Data source: entity.gross_receipts is keyed by `{FormType}_{ShortType}_{Year}`
 * (e.g. `1120S_RoA_2023`). Each value carries `{ severity, flags, financials,
 * screened_at, ... }`. We aggregate by year, prefer Record-of-Account over
 * Return Transcript when both exist (RoA has more granular line items), and
 * render a 3-year side-by-side table.
 *
 * Pure function: takes a CashFlowInput, returns a PDF byte array. Caller
 * handles storage upload + invoicing.
 */

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CashFlowInput {
  entityName: string;
  tin: string;          // EIN/SSN — masked in render to last-4 only
  formType: string;     // "1120S" | "1040" | etc.
  loanNumber: string | null;
  lenderName: string;
  /** Raw entity.gross_receipts JSON. */
  grossReceipts: Record<string, any> | null;
  /** Generated-on date for the footer. */
  generatedAt: Date;
  /** Generated-by user (full name). For audit footer. */
  generatedBy: string;
}

export interface YearCashFlow {
  year: string;
  /** Where the data came from — "1120S_RoA_2023" etc. Shown in fine print. */
  source: string;
  grossReceipts: number | null;
  totalIncome: number | null;
  totalDeductions: number | null;
  netIncome: number | null;
  totalTax: number | null;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Pull per-year financials out of the entity.gross_receipts JSON map.
 *
 * Sort priority within a single year:
 *   1. Record of Account ('RoA') — has both filing + account data
 *   2. Return Transcript ('RT') — filing data only
 *   3. Anything else (account_transcript / wage_income skipped)
 *
 * Returns up to 3 most-recent years sorted descending.
 */
export function aggregateCashFlowByYear(
  grossReceipts: Record<string, any> | null,
): YearCashFlow[] {
  if (!grossReceipts || typeof grossReceipts !== 'object') return [];

  // Group entries by year so we can pick the best source per year.
  const byYear: Record<string, Array<{ key: string; entry: any; priority: number }>> = {};
  for (const [key, entry] of Object.entries(grossReceipts)) {
    if (key === 'entity_transcript' || key === 'entity_transcript_order') continue;
    if (!entry || typeof entry !== 'object') continue;
    if (!entry.financials) continue;

    // Key shape: {FormType}_{ShortType}_{Year} — RoA / RT / WI / ACT
    const parts = key.split('_');
    if (parts.length < 3) continue;
    const year = parts[parts.length - 1];
    const shortType = parts[parts.length - 2];
    if (!/^\d{4}$/.test(year)) continue;
    // Skip wage-income / account-only — they don't have business cash flow.
    if (shortType === 'WI' || shortType === 'ACT') continue;

    const priority = shortType === 'RoA' ? 0 : shortType === 'RT' ? 1 : 2;
    byYear[year] = byYear[year] || [];
    byYear[year].push({ key, entry, priority });
  }

  // Pick the best entry per year.
  const yearRows: YearCashFlow[] = [];
  for (const [year, candidates] of Object.entries(byYear)) {
    candidates.sort((a, b) => a.priority - b.priority);
    const winner = candidates[0];
    const f = winner.entry.financials || {};
    const totalIncome = typeof f.totalIncome === 'number' ? f.totalIncome : null;
    const totalDeductions = typeof f.totalDeductions === 'number' ? f.totalDeductions : null;
    const netIncome =
      totalIncome !== null && totalDeductions !== null ? totalIncome - totalDeductions : null;
    yearRows.push({
      year,
      source: winner.key,
      grossReceipts: typeof f.grossReceipts === 'number' ? f.grossReceipts : null,
      totalIncome,
      totalDeductions,
      netIncome,
      totalTax: typeof f.totalTax === 'number' ? f.totalTax : null,
    });
  }

  // Most recent 3 years, descending.
  yearRows.sort((a, b) => b.year.localeCompare(a.year));
  return yearRows.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const COLOR_NAVY = rgb(0.07, 0.12, 0.27);
const COLOR_GREEN = rgb(0, 0.76, 0.55);
const COLOR_GREY = rgb(0.4, 0.4, 0.45);
const COLOR_LIGHT = rgb(0.95, 0.96, 0.98);
const COLOR_BORDER = rgb(0.85, 0.86, 0.9);
const COLOR_AMBER_BG = rgb(1, 0.97, 0.88);
const COLOR_AMBER_TEXT = rgb(0.55, 0.4, 0);

function fmtMoney(n: number | null): string {
  if (n === null || isNaN(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function maskTin(tin: string): string {
  const digits = tin.replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return `***-**-${digits.slice(-4)}`;
}

function drawText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number,
  color = rgb(0, 0, 0),
) {
  page.drawText(text, { x, y, size, font, color });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Render the SBA Cash-Flow Analysis Pack as a 1-page PDF.
 *
 * Returns Uint8Array (PDF bytes). Caller uploads to storage + delivers.
 */
export async function generateCashFlowPdf(input: CashFlowInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US Letter
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const { width, height } = page.getSize();
  const yearRows = aggregateCashFlowByYear(input.grossReceipts);

  // ---- Header banner ----
  page.drawRectangle({ x: 0, y: height - 80, width, height: 80, color: COLOR_NAVY });
  drawText(page, 'ModernTax', 36, height - 35, helvBold, 18, rgb(1, 1, 1));
  drawText(page, 'SBA Cash-Flow Analysis Pack', 36, height - 58, helv, 11, rgb(0.85, 0.9, 1));
  drawText(page, `Generated ${input.generatedAt.toLocaleDateString('en-US')}`, width - 180, height - 35, helv, 9, rgb(0.85, 0.9, 1));
  drawText(page, `For: ${input.lenderName}`, width - 180, height - 50, helv, 9, rgb(0.85, 0.9, 1));

  // ---- Entity block ----
  let y = height - 110;
  drawText(page, input.entityName, 36, y, helvBold, 14, COLOR_NAVY);
  y -= 16;
  drawText(
    page,
    `Form ${input.formType}  ·  TIN ${maskTin(input.tin)}${input.loanNumber ? `  ·  Loan ${input.loanNumber}` : ''}`,
    36, y, helv, 10, COLOR_GREY,
  );
  y -= 25;

  // ---- Cash-flow table ----
  if (yearRows.length === 0) {
    // No financials extracted — typically W&I-only entities or pre-screening.
    page.drawRectangle({ x: 36, y: y - 60, width: width - 72, height: 60, color: COLOR_AMBER_BG, borderColor: COLOR_BORDER, borderWidth: 1 });
    drawText(page, 'No cash-flow data available', 50, y - 22, helvBold, 11, COLOR_AMBER_TEXT);
    drawText(page, 'This entity has no transcripts with extractable financials yet.', 50, y - 38, helv, 9, COLOR_AMBER_TEXT);
    drawText(page, 'Pull a Record of Account or Return Transcript first.', 50, y - 50, helv, 9, COLOR_AMBER_TEXT);
    y -= 70;
  } else {
    // Header row
    const colWidths = [200, 100, 100, 100, 100];
    const colX = [36, 236, 336, 436, 536];
    const yearLabels = ['Line Item', ...yearRows.map(r => r.year), ...Array(3 - yearRows.length).fill('—')];

    page.drawRectangle({ x: 36, y: y - 22, width: width - 72, height: 22, color: COLOR_NAVY });
    yearLabels.slice(0, 4).forEach((lbl, i) => {
      drawText(page, lbl, colX[i] + (i === 0 ? 8 : (colWidths[i] - helv.widthOfTextAtSize(lbl, 10)) / 2), y - 16, helvBold, 10, rgb(1, 1, 1));
    });
    y -= 22;

    const lineItems: Array<{ label: string; key: keyof YearCashFlow; bold?: boolean; bg?: any }> = [
      { label: 'Gross Receipts', key: 'grossReceipts' },
      { label: 'Total Income', key: 'totalIncome' },
      { label: 'Total Deductions', key: 'totalDeductions' },
      { label: 'Net Income', key: 'netIncome', bold: true, bg: COLOR_LIGHT },
      { label: 'Total Tax', key: 'totalTax' },
    ];

    lineItems.forEach((item, i) => {
      const rowY = y - 18;
      if (item.bg) page.drawRectangle({ x: 36, y: rowY, width: width - 72, height: 18, color: item.bg });
      const font = item.bold ? helvBold : helv;
      drawText(page, item.label, 44, rowY + 5, font, 10, COLOR_NAVY);
      yearRows.forEach((r, idx) => {
        const v = r[item.key] as number | null;
        const txt = fmtMoney(v);
        const cx = colX[idx + 1];
        const w = colWidths[idx + 1] - 8;
        const tw = font.widthOfTextAtSize(txt, 10);
        drawText(page, txt, cx + w - tw, rowY + 5, font, 10, item.bold ? COLOR_NAVY : rgb(0.2, 0.2, 0.25));
      });
      // Border line
      page.drawLine({
        start: { x: 36, y: rowY },
        end: { x: width - 36, y: rowY },
        thickness: 0.5,
        color: COLOR_BORDER,
      });
      y -= 18;
      void i;
    });

    y -= 16;

    // ---- Add-backs section (manual entry) ----
    drawText(page, 'Cash-flow add-backs (verify against return)', 36, y, helvBold, 11, COLOR_NAVY);
    y -= 4;
    drawText(page, 'Underwriter to confirm from Schedule M-1 / depreciation schedules', 36, y - 10, helv, 9, COLOR_GREY);
    y -= 24;

    const addBacks = [
      'Depreciation / Amortization',
      'Interest Expense',
      'Owner Compensation',
      'Non-recurring / One-time items',
    ];
    addBacks.forEach((label) => {
      const rowY = y - 18;
      drawText(page, label, 44, rowY + 5, helv, 10, rgb(0.2, 0.2, 0.25));
      yearRows.forEach((_, idx) => {
        const cx = colX[idx + 1];
        const w = colWidths[idx + 1] - 8;
        // Empty box for processor fill-in
        page.drawRectangle({
          x: cx + 4, y: rowY + 2, width: w - 4, height: 14,
          borderColor: COLOR_BORDER, borderWidth: 0.5, color: rgb(1, 1, 1),
        });
      });
      page.drawLine({
        start: { x: 36, y: rowY }, end: { x: width - 36, y: rowY },
        thickness: 0.5, color: COLOR_BORDER,
      });
      y -= 18;
    });

    // ---- Adjusted cash flow row ----
    const acfY = y - 22;
    page.drawRectangle({ x: 36, y: acfY, width: width - 72, height: 22, color: COLOR_GREEN });
    drawText(page, 'Adjusted Cash Flow (Net Income + Add-backs)', 44, acfY + 6, helvBold, 11, rgb(1, 1, 1));
    yearRows.forEach((r, idx) => {
      const cx = colX[idx + 1];
      const w = colWidths[idx + 1] - 8;
      const txt = `${fmtMoney(r.netIncome)} + ?`;
      const tw = helv.widthOfTextAtSize(txt, 9);
      drawText(page, txt, cx + w - tw, acfY + 6, helv, 9, rgb(1, 1, 1));
    });
    y = acfY - 16;
  }

  // ---- Sources note ----
  if (yearRows.length > 0) {
    drawText(page, 'Sources:', 36, y, helvBold, 9, COLOR_GREY);
    y -= 11;
    yearRows.forEach((r) => {
      drawText(page, `  • ${r.year}: ${r.source.replace(/_/g, ' ')}`, 36, y, helv, 8, COLOR_GREY);
      y -= 10;
    });
  }

  // ---- Footer ----
  const footerY = 36;
  page.drawLine({
    start: { x: 36, y: footerY + 18 },
    end: { x: width - 36, y: footerY + 18 },
    thickness: 0.5, color: COLOR_BORDER,
  });
  drawText(
    page,
    `Generated by ${input.generatedBy} on ${input.generatedAt.toLocaleString('en-US')}.  Source: IRS transcripts pulled by ModernTax.`,
    36, footerY + 6, helv, 8, COLOR_GREY,
  );
  drawText(
    page,
    'This worksheet is for SBA underwriting reference only. Verify all figures against original tax returns before approval.',
    36, footerY - 6, helv, 8, COLOR_GREY,
  );

  return doc.save();
}
