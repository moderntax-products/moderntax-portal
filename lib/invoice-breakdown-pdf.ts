/**
 * Invoice breakdown PDF generator.
 *
 * Renders the per-processor / per-entity itemization (same shape as
 * InvoiceBreakdownTable + the SendGrid email body) into a printable
 * PDF that's attached to the customer invoicing email. Lets the AP
 * team file the breakdown alongside the Mercury PDF without needing
 * to log into the portal.
 *
 * Driver: 2026-05-29 Matt — "Needs to be an attached PDF to the email
 * with the itemization."
 *
 * Pure function: takes the breakdown + invoice metadata, returns a
 * Buffer. WinAnsi-safe character set (no emoji / em-dash) — pdf-lib's
 * StandardFonts.Helvetica only encodes WinAnsi (lesson learned from
 * the loan-consolidation generator).
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export interface BreakdownInput {
  clientName: string;
  invoiceNumber: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;
  grandTotal: number;
  payUrl: string | null;
  isTest: boolean;
  processorGroups: Array<{
    processor: string;
    entities: Array<{
      entity_name: string;
      form_type: string | null;
      completed_at: string | null;
      loan_number: string | null;
      unit_price: number;
      is_reorder: boolean;
    }>;
    subtotal: number;
  }>;
  monitoringDetails: Array<{
    entity_name: string;
    processor: string;
    window_start: string;
    window_end: string;
    active_days: number;
    prorated: number;
  }>;
  catchupLine: { amount: number; memo: string; label?: string } | null;
}

const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Make arbitrary DB text safe for pdf-lib's StandardFonts (WinAnsi encoding).
 * WinAnsi cannot encode control chars (tabs/newlines) or most non-Latin-1
 * code points — passing them to drawText throws and aborts the whole render.
 * Real-world data hits this constantly: a processor profile imported with a
 * leading tab ("\tErin Wilsey"), business names with smart quotes / em-dashes,
 * etc. Normalize the common offenders and replace anything still un-encodable
 * with '?' so the PDF always renders.
 */
const clean = (s: unknown): string =>
  String(s ?? '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[ \t]/g, ' ')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/[^\x20-\x7E\xA1-\xFF]/g, '?')
    .replace(/ {2,}/g, ' ')
    .trim();

export async function generateInvoiceBreakdownPdf(input: BreakdownInput): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const navy = rgb(0.04, 0.10, 0.16);
  const accent = rgb(0.0, 0.77, 0.55);
  const muted = rgb(0.42, 0.45, 0.50);
  const danger = rgb(0.73, 0.11, 0.11);
  const blueHdr = rgb(0.05, 0.36, 0.62);
  const headerBg = rgb(0.95, 0.97, 1.0);

  const PAGE_W = 612;
  const PAGE_H = 792;
  const MARGIN = 50;

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const drawText = (text: string, opts: { x?: number; size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; max?: number } = {}) => {
    const size = opts.size ?? 10;
    const x = opts.x ?? MARGIN;
    const usedFont = opts.bold ? fontBold : font;
    let line = clean(text);
    if (opts.max && opts.max > 0 && usedFont.widthOfTextAtSize(line, size) > opts.max) {
      // Shrink the base text one char at a time, measuring WITH the ellipsis
      // appended. The previous form (`line = line.slice(0,-2) + '...'`) removed
      // 2 chars but re-added 3 every pass, so the string GREW and the loop
      // never terminated → infinite hang on any over-wide cell (the blank-
      // breakdown / endpoint-timeout bug, fixed 2026-06-01).
      while (line.length > 1 && usedFont.widthOfTextAtSize(line + '...', size) > opts.max) {
        line = line.slice(0, -1);
      }
      line = line + '...';
    }
    page.drawText(line, { x, y, size, font: usedFont, color: opts.color ?? navy });
    y -= size + 4;
  };

  const drawRowLine = (cells: Array<{ text: string; x: number; w: number; bold?: boolean; color?: ReturnType<typeof rgb>; align?: 'left' | 'right'; size?: number }>) => {
    const size = cells[0]?.size ?? 9;
    for (const c of cells) {
      const cellFont = c.bold ? fontBold : font;
      let txt = clean(c.text);
      if (cellFont.widthOfTextAtSize(txt, size) > c.w - 4) {
        // See drawText above: net-shrink with the ellipsis measured in, or this
        // loop grows the string forever and hangs the whole PDF render.
        while (txt.length > 1 && cellFont.widthOfTextAtSize(txt + '...', size) > c.w - 4) {
          txt = txt.slice(0, -1);
        }
        txt = txt + '...';
      }
      const tx = c.align === 'right'
        ? c.x + c.w - cellFont.widthOfTextAtSize(txt, size) - 2
        : c.x + 2;
      page.drawText(txt, { x: tx, y, size, font: cellFont, color: c.color ?? navy });
    }
    y -= size + 4;
  };

  const ensureSpace = (rowsNeeded: number, rowHeight = 14) => {
    if (y - rowsNeeded * rowHeight < MARGIN) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };

  // ----- Header -----
  drawText('Invoice Breakdown', { size: 20, bold: true });
  y -= 2;
  drawText(`${input.clientName}`, { size: 13, color: muted });
  drawText(`${input.invoiceNumber}  |  Period: ${input.periodStart} -> ${input.periodEnd}`, { size: 10, color: muted });
  if (input.isTest) {
    y -= 2;
    drawText('*** TEST INVOICE - NOT FOR PAYMENT ***', { size: 10, bold: true, color: danger });
  }
  y -= 10;

  // ----- Total hero box -----
  // Draw label + total at fixed baselines INSIDE the box (vertically centered),
  // then drop the cursor clearly BELOW the box so the next section heading never
  // overlaps the box border (was: cursor ended ~2px below the box, so the heading
  // text rose back into it — 2026-06-30 layout fix).
  ensureSpace(4);
  const boxTop = y;
  const boxH = 42;
  page.drawRectangle({
    x: MARGIN, y: boxTop - boxH, width: PAGE_W - MARGIN * 2, height: boxH,
    color: rgb(0.92, 0.98, 0.95),
    borderColor: accent, borderWidth: 1,
  });
  page.drawText('TOTAL DUE', {
    x: MARGIN + 14, y: boxTop - 24, size: 10, font: fontBold, color: rgb(0.08, 0.49, 0.24),
  });
  const totalStr = fmt(input.grandTotal);
  const totalSize = 18;
  const totalW = fontBold.widthOfTextAtSize(totalStr, totalSize);
  page.drawText(totalStr, {
    x: PAGE_W - MARGIN - 14 - totalW, y: boxTop - 28, size: totalSize, font: fontBold, color: navy,
  });
  y = boxTop - boxH - 22;

  // ----- Verification: per-processor groups -----
  if (input.processorGroups.length > 0) {
    drawText('Tax Verification - by loan officer', { size: 12, bold: true, color: accent });
    y -= 2;

    const colE = MARGIN;
    const colF = MARGIN + 230;
    const colL = MARGIN + 290;
    const colD = MARGIN + 380;
    const colA = MARGIN + 460;
    const tableW = PAGE_W - MARGIN * 2;
    const colWEntity = 226;
    const colWForm = 58;
    const colWLoan = 86;
    const colWDate = 76;
    const colWAmt = 50;

    // Header row
    page.drawRectangle({ x: MARGIN, y: y - 12, width: tableW, height: 14, color: headerBg });
    drawRowLine([
      { text: 'ENTITY', x: colE, w: colWEntity, bold: true, color: muted, size: 8 },
      { text: 'FORM', x: colF, w: colWForm, bold: true, color: muted, size: 8 },
      { text: 'LOAN', x: colL, w: colWLoan, bold: true, color: muted, size: 8 },
      { text: 'COMPLETED', x: colD, w: colWDate, bold: true, color: muted, size: 8 },
      { text: 'AMOUNT', x: colA, w: colWAmt, bold: true, color: muted, size: 8, align: 'right' },
    ]);

    for (const g of input.processorGroups) {
      ensureSpace(g.entities.length + 2);
      // Group header
      page.drawRectangle({ x: MARGIN, y: y - 12, width: tableW, height: 14, color: rgb(0.93, 0.96, 1.0) });
      drawRowLine([
        { text: `${g.processor}  -  ${g.entities.length} ${g.entities.length === 1 ? 'entity' : 'entities'}`, x: MARGIN, w: tableW - colWAmt - 8, bold: true, color: blueHdr, size: 9 },
        { text: fmt(g.subtotal), x: colA, w: colWAmt, bold: true, color: blueHdr, size: 9, align: 'right' },
      ]);
      for (const e of g.entities) {
        ensureSpace(1);
        const ename = `${e.entity_name}${e.is_reorder ? ' [REORDER]' : ''}`;
        drawRowLine([
          { text: ename, x: colE, w: colWEntity, size: 9 },
          { text: e.form_type || '-', x: colF, w: colWForm, size: 8, color: muted },
          { text: e.loan_number || '-', x: colL, w: colWLoan, size: 8, color: muted },
          { text: e.completed_at ? e.completed_at.slice(0, 10) : '-', x: colD, w: colWDate, size: 8, color: muted },
          { text: fmt(e.unit_price), x: colA, w: colWAmt, size: 9, align: 'right' },
        ]);
      }
      y -= 4;
    }
    y -= 6;
  }

  // ----- Monitoring -----
  if (input.monitoringDetails.length > 0) {
    ensureSpace(input.monitoringDetails.length + 3);
    drawText('Account Monitoring - by enrollment', { size: 12, bold: true, color: accent });
    y -= 2;
    const colE = MARGIN;
    const colP = MARGIN + 200;
    const colW = MARGIN + 320;
    const colA = MARGIN + 460;
    const tableW = PAGE_W - MARGIN * 2;
    page.drawRectangle({ x: MARGIN, y: y - 12, width: tableW, height: 14, color: headerBg });
    drawRowLine([
      { text: 'ENTITY', x: colE, w: 196, bold: true, color: muted, size: 8 },
      { text: 'LOAN OFFICER', x: colP, w: 116, bold: true, color: muted, size: 8 },
      { text: 'WINDOW', x: colW, w: 136, bold: true, color: muted, size: 8 },
      { text: 'PRORATED', x: colA, w: 50, bold: true, color: muted, size: 8, align: 'right' },
    ]);
    for (const m of input.monitoringDetails) {
      ensureSpace(1);
      drawRowLine([
        { text: m.entity_name, x: colE, w: 196, size: 9 },
        { text: m.processor, x: colP, w: 116, size: 8, color: muted },
        { text: `${m.window_start} -> ${m.window_end} (${m.active_days}/31d)`, x: colW, w: 136, size: 8, color: muted },
        { text: fmt(m.prorated), x: colA, w: 50, size: 9, align: 'right' },
      ]);
    }
    y -= 6;
  }

  // ----- Catch-up -----
  if (input.catchupLine) {
    ensureSpace(4);
    drawText(input.catchupLine.label || 'Catch-up balance', { size: 12, bold: true, color: danger });
    y -= 2;
    page.drawRectangle({
      x: MARGIN, y: y - 30, width: PAGE_W - MARGIN * 2, height: 32,
      color: rgb(1.0, 0.96, 0.96),
      borderColor: danger, borderWidth: 0.6,
    });
    const memoMax = PAGE_W - MARGIN * 2 - 100;
    drawText(input.catchupLine.memo, { x: MARGIN + 10, size: 9, color: navy, max: memoMax });
    y += 14;
    const amtStr = fmt(input.catchupLine.amount);
    const amtW = fontBold.widthOfTextAtSize(amtStr, 12);
    page.drawText(amtStr, {
      x: PAGE_W - MARGIN - 10 - amtW,
      y,
      size: 12, font: fontBold, color: danger,
    });
    y -= 22;
  }

  // ----- Footer with pay link -----
  ensureSpace(4);
  y -= 8;
  drawText('Pay via Mercury (ACH only, net 5 days):', { size: 10, bold: true });
  if (input.payUrl) {
    drawText(input.payUrl, { size: 9, color: blueHdr, max: PAGE_W - MARGIN * 2 });
  }
  y -= 6;
  drawText('ModernTax Inc.  |  IRS Practitioner Priority Service  |  Questions: matt@moderntax.io', { size: 8, color: muted });
  drawText(`Full audit trail also lives at https://portal.moderntax.io/invoicing`, { size: 8, color: muted });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
