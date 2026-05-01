/**
 * Invoice Breakdown PDF Generator
 *
 * Produces the standardized "INV-17 style" itemized invoice PDF that customers
 * receive alongside the Mercury invoice email. Mercury's PDF is a rollup line
 * item; this PDF is the receipt-quality breakdown — every entity, who
 * processed it, when it completed, what it cost.
 *
 * Layout (matches the Centerstone INV-17 reference exactly):
 *   - Dark navy header banner with company name + INVOICE label
 *   - Bill To + invoice metadata box
 *   - Tax Verification Services table, grouped by Requesting Member (processor)
 *   - 8821 Generation surcharge section (if any self-signed entities)
 *   - Transcript Monitoring section (one-time enrollment, per-pull updates,
 *     entity transcript fees if processor opted in)
 *   - Page 2: Summary by Member, Total Due box, Notes
 *
 * Pure function: takes an InvoicePdfInput, returns a PDF byte array. Caller
 * is responsible for storage upload + email.
 */

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InvoicePdfInput {
  invoiceNumber: string;          // "INV-2026-04-CENT"
  invoiceDate: string;            // "2026-05-01"
  dueDate: string;                // "2026-05-06"
  billingPeriodStart: string;     // "2026-04-01"
  billingPeriodEnd: string;       // "2026-04-30"
  paymentTerms: string;           // "Net 5 - ACH"
  payUrl?: string | null;

  client: {
    name: string;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
  };

  /** Tax-verification entities grouped by the processor who requested them. */
  verificationGroups: VerificationGroup[];

  /**
   * Per-entity entity-transcript add-ons ($19.99 each when processor opted to
   * pull the entity transcript on top of the standard ROA/return transcript).
   */
  entityTranscripts: EntityTranscriptItem[];

  /** ModernTax-signed 8821 surcharge ($10/entity). Null if zero. */
  selfSigned8821: { count: number; unitPrice: number; total: number } | null;

  /** Monitoring activity in the period (enrollments, pulls, by processor). */
  monitoringGroups: MonitoringGroup[];

  /** Free-form notes (rendered as bullet list at end of summary page). */
  notes: string[];
}

export interface VerificationGroup {
  processorName: string;
  entities: VerificationEntity[];
}
export interface VerificationEntity {
  entityName: string;
  formType: string;        // "1040" | "1120S" | etc.
  loanNumber: string;      // arbitrary string ("18016", "countryside", "")
  completedAt: string;     // "MM/DD/YYYY" already formatted
  unitPrice: number;       // 59.98
}
export interface EntityTranscriptItem {
  processorName: string;
  entityName: string;
  loanNumber: string;
  date: string;
  unitPrice: number;       // 19.99
}
export interface MonitoringGroup {
  processorName: string;
  items: MonitoringItem[];
}
export interface MonitoringItem {
  description: string;     // "Justin Pizzola - Monitoring Enrollment (Weekly)"
  loanNumber: string;
  date: string;            // "MM/DD/YYYY"
  unitPrice: number;
}

// ---------------------------------------------------------------------------
// Layout constants (Letter, points)
// ---------------------------------------------------------------------------

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_X = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

// Color palette
const NAVY = rgb(0.10, 0.16, 0.27);          // #1a2845 — header banner
const NAVY_DARK = rgb(0.06, 0.10, 0.16);     // page footer
const ACCENT = rgb(0.16, 0.36, 0.62);        // #295c9e — section headers
const ACCENT_LIGHT = rgb(0.86, 0.93, 1.00);  // subtle row tint
const TEXT_PRIMARY = rgb(0.10, 0.10, 0.10);
const TEXT_MUTED = rgb(0.42, 0.45, 0.50);
const ROW_ALT = rgb(0.97, 0.98, 0.99);
const BORDER = rgb(0.85, 0.87, 0.90);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvB = await pdf.embedFont(StandardFonts.HelveticaBold);

  const page1 = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const ctx: RenderCtx = { pdf, page: page1, helv, helvB, y: PAGE_HEIGHT, pageNumber: 1 };

  drawHeaderBanner(ctx, input);
  drawBillToAndMeta(ctx, input);
  drawSectionTitle(ctx, 'Tax Verification Services',
    `(IRS Tax Return + Record of Account)  |  Grouped by Requesting Member  |  Billing Period: ${formatRange(input)}`);
  drawTableHeader(ctx, ['#', 'Entity Name', 'Form', 'Loan #', 'Completed', 'Unit Price', 'Amount'],
    [22, 220, 50, 60, 70, 60, 60]);

  // Tax verification table (continues onto new pages if needed)
  let runningRowNum = 0;
  let verificationSubtotal = 0;
  for (const group of input.verificationGroups) {
    const groupTotal = group.entities.reduce((s, e) => s + e.unitPrice, 0);
    verificationSubtotal += groupTotal;
    ensureRoom(ctx, 26);
    drawProcessorRow(ctx, `${group.processorName}  (${group.entities.length} ${group.entities.length === 1 ? 'entity' : 'entities'})`, groupTotal);
    for (const ent of group.entities) {
      runningRowNum++;
      ensureRoom(ctx, 18);
      drawVerificationDataRow(ctx, runningRowNum, ent);
    }
  }

  // Entity transcript add-ons (if any)
  let entityTranscriptSubtotal = 0;
  if (input.entityTranscripts.length > 0) {
    ensureRoom(ctx, 24);
    drawProcessorRow(ctx,
      `Entity Transcript Add-ons  (${input.entityTranscripts.length} ${input.entityTranscripts.length === 1 ? 'entity' : 'entities'})`,
      input.entityTranscripts.reduce((s, e) => s + e.unitPrice, 0));
    for (const item of input.entityTranscripts) {
      runningRowNum++;
      ensureRoom(ctx, 18);
      drawVerificationDataRow(ctx, runningRowNum, {
        entityName: item.entityName + ' (Entity Transcript)',
        formType: '-',
        loanNumber: item.loanNumber,
        completedAt: item.date,
        unitPrice: item.unitPrice,
      });
      entityTranscriptSubtotal += item.unitPrice;
    }
  }

  // Verification grand subtotal line
  ensureRoom(ctx, 22);
  drawSubtotalLine(ctx,
    `Subtotal (${runningRowNum} ${runningRowNum === 1 ? 'item' : 'items'}):`,
    verificationSubtotal + entityTranscriptSubtotal);

  // 8821 self-signed surcharge — single-row section, no table needed
  if (input.selfSigned8821 && input.selfSigned8821.count > 0) {
    ensureRoom(ctx, 70);
    ctx.y -= 14;
    drawSectionTitle(ctx, '8821 Generation & Signature',
      `(ModernTax-prepared & signed Form 8821 - ${input.selfSigned8821.count} entities)`);
    drawProcessorRow(ctx,
      `${input.selfSigned8821.count} x $${input.selfSigned8821.unitPrice.toFixed(2)} (auto-prepared & e-signed)`,
      input.selfSigned8821.total);
    ensureRoom(ctx, 22);
    drawSubtotalLine(ctx, '8821 Service Subtotal:', input.selfSigned8821.total);
  }

  // Monitoring section
  let monitoringSubtotal = 0;
  if (input.monitoringGroups.length > 0) {
    ensureRoom(ctx, 60);
    ctx.y -= 14;
    drawSectionTitle(ctx, 'Transcript Monitoring',
      '(Recurring IRS Transcript Updates  |  $19.99 enrollment one-time  |  $39.99 per update pull)');
    drawTableHeader(ctx, ['#', 'Description', 'Loan #', 'Date', 'Unit Price', 'Amount'],
      [22, 240, 80, 70, 60, 60]);
    let monRowNum = 0;
    for (const group of input.monitoringGroups) {
      const groupTotal = group.items.reduce((s, i) => s + i.unitPrice, 0);
      monitoringSubtotal += groupTotal;
      ensureRoom(ctx, 26);
      drawProcessorRow(ctx, `${group.processorName}  (Monitoring Activity)`, groupTotal);
      for (const item of group.items) {
        monRowNum++;
        ensureRoom(ctx, 18);
        drawMonitoringDataRow(ctx, monRowNum, item);
      }
    }
    ensureRoom(ctx, 22);
    drawSubtotalLine(ctx, 'Monitoring Subtotal:', monitoringSubtotal);
  }

  // Page footer
  drawPageFooter(ctx);

  // -------------------------------------------------------------------------
  // Page 2 — Summary
  // -------------------------------------------------------------------------
  const summaryPage = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  // Use the running ctx page count (page 1 may have added continuation
  // pages mid-table) so the summary page footer numbers correctly.
  const ctx2: RenderCtx = {
    pdf, page: summaryPage, helv, helvB, y: PAGE_HEIGHT, pageNumber: ctx.pageNumber + 1,
  };
  drawSummaryHeader(ctx2, input);

  // Summary by Member
  drawSubsectionTitle(ctx2, 'Summary by Member');
  drawTableHeader(ctx2, ['Member', 'Entities', 'Subtotal'], [320, 90, 80]);
  for (const group of input.verificationGroups) {
    const subtotal = group.entities.reduce((s, e) => s + e.unitPrice, 0);
    ensureRoom(ctx2, 18);
    drawSummaryDataRow(ctx2, group.processorName, group.entities.length, subtotal);
  }
  ctx2.y -= 6;
  drawSubtotalLine(ctx2,
    `Tax Verification Subtotal (${input.verificationGroups.reduce((s, g) => s + g.entities.length, 0)} entities)`,
    verificationSubtotal);

  // Total Due box
  ctx2.y -= 22;
  const totalDue = verificationSubtotal + entityTranscriptSubtotal + monitoringSubtotal +
    (input.selfSigned8821?.total || 0);
  drawTotalDueBox(ctx2, {
    verification: verificationSubtotal,
    entityTranscripts: entityTranscriptSubtotal,
    selfSigned8821: input.selfSigned8821?.total || 0,
    monitoring: monitoringSubtotal,
    total: totalDue,
  });

  // Pay button line (if pay URL provided)
  if (input.payUrl) {
    ctx2.y -= 22;
    drawPayLink(ctx2, input.payUrl);
  }

  // Notes
  if (input.notes.length > 0) {
    ctx2.y -= 24;
    drawSubsectionTitle(ctx2, 'Notes');
    for (const note of input.notes) {
      ensureRoom(ctx2, 16);
      drawNoteBullet(ctx2, note);
    }
  }

  drawPageFooter(ctx2, 2);

  return pdf.save();
}

// ---------------------------------------------------------------------------
// Internal: render context + helpers
// ---------------------------------------------------------------------------

interface RenderCtx {
  pdf: PDFDocument;
  page: PDFPage;
  helv: PDFFont;
  helvB: PDFFont;
  y: number;
  pageNumber: number;
}

/** Add a continuation page if there isn't enough vertical room. */
function ensureRoom(ctx: RenderCtx, needed: number) {
  if (ctx.y - needed < 70) {
    drawPageFooter(ctx);
    ctx.pageNumber += 1;
    ctx.page = ctx.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    ctx.y = PAGE_HEIGHT - 40;
  }
}

function drawHeaderBanner(ctx: RenderCtx, input: InvoicePdfInput) {
  // Navy banner
  ctx.page.drawRectangle({
    x: 0, y: PAGE_HEIGHT - 110, width: PAGE_WIDTH, height: 110, color: NAVY,
  });
  // Company name
  ctx.page.drawText('Rapidly Financial Inc', {
    x: MARGIN_X, y: PAGE_HEIGHT - 50, size: 22, font: ctx.helvB, color: rgb(1, 1, 1),
  });
  ctx.page.drawText('DBA ModernTax  |  651 N Broad St, Suite 201, Middletown, DE 19709', {
    x: MARGIN_X, y: PAGE_HEIGHT - 70, size: 9, font: ctx.helv, color: rgb(0.85, 0.88, 0.92),
  });
  ctx.page.drawText('matt@moderntax.io', {
    x: MARGIN_X, y: PAGE_HEIGHT - 84, size: 9, font: ctx.helv, color: rgb(0.85, 0.88, 0.92),
  });
  // INVOICE label, right-aligned
  const invoiceLabel = 'INVOICE';
  const invoiceLabelWidth = ctx.helvB.widthOfTextAtSize(invoiceLabel, 26);
  ctx.page.drawText(invoiceLabel, {
    x: PAGE_WIDTH - MARGIN_X - invoiceLabelWidth, y: PAGE_HEIGHT - 50,
    size: 26, font: ctx.helvB, color: rgb(1, 1, 1),
  });
  const invoiceNumWidth = ctx.helv.widthOfTextAtSize(input.invoiceNumber, 11);
  ctx.page.drawText(input.invoiceNumber, {
    x: PAGE_WIDTH - MARGIN_X - invoiceNumWidth, y: PAGE_HEIGHT - 70,
    size: 11, font: ctx.helv, color: rgb(0.85, 0.88, 0.92),
  });

  ctx.y = PAGE_HEIGHT - 130;
}

function drawBillToAndMeta(ctx: RenderCtx, input: InvoicePdfInput) {
  // Bill To (left side)
  ctx.page.drawText('BILL TO', {
    x: MARGIN_X, y: ctx.y, size: 8, font: ctx.helvB, color: TEXT_MUTED,
  });
  ctx.page.drawText(input.client.name, {
    x: MARGIN_X, y: ctx.y - 18, size: 14, font: ctx.helvB, color: TEXT_PRIMARY,
  });
  let cursor = ctx.y - 34;
  if (input.client.addressLine1) {
    ctx.page.drawText(input.client.addressLine1 + (input.client.addressLine2 ? `, ${input.client.addressLine2}` : ''), {
      x: MARGIN_X, y: cursor, size: 10, font: ctx.helv, color: TEXT_PRIMARY,
    });
    cursor -= 14;
  }
  if (input.client.city || input.client.state) {
    const line = [input.client.city, input.client.state, input.client.postalCode].filter(Boolean).join(', ');
    ctx.page.drawText(line, {
      x: MARGIN_X, y: cursor, size: 10, font: ctx.helv, color: TEXT_PRIMARY,
    });
    cursor -= 14;
  }

  // Metadata box (right side, light gray)
  const boxX = PAGE_WIDTH / 2 + 30;
  const boxW = PAGE_WIDTH - MARGIN_X - boxX;
  const boxH = 80;
  ctx.page.drawRectangle({
    x: boxX, y: ctx.y - boxH + 6, width: boxW, height: boxH,
    color: rgb(0.95, 0.96, 0.98), borderColor: BORDER, borderWidth: 0.5,
  });
  const metaPairs: [string, string][] = [
    ['Invoice Date:', formatDateLong(input.invoiceDate)],
    ['Due Date:',     formatDateLong(input.dueDate)],
    ['Payment Terms:', input.paymentTerms],
  ];
  let metaY = ctx.y - 14;
  for (const [k, v] of metaPairs) {
    ctx.page.drawText(k, { x: boxX + 12, y: metaY, size: 9, font: ctx.helv, color: TEXT_MUTED });
    const valW = ctx.helvB.widthOfTextAtSize(v, 10);
    ctx.page.drawText(v, {
      x: boxX + boxW - 12 - valW, y: metaY, size: 10, font: ctx.helvB, color: TEXT_PRIMARY,
    });
    metaY -= 22;
  }

  ctx.y = Math.min(cursor, ctx.y - boxH) - 10;
}

/**
 * Section title block: bold title + smaller muted subtitle on the next line
 * (subtitle wraps if needed) + underline. Caller is responsible for drawing
 * any column headers afterward via drawTableHeader().
 */
function drawSectionTitle(ctx: RenderCtx, title: string, subtitle?: string) {
  ctx.y -= 6;
  ctx.page.drawText(title, {
    x: MARGIN_X, y: ctx.y, size: 13, font: ctx.helvB, color: TEXT_PRIMARY,
  });
  ctx.y -= 12;
  if (subtitle) {
    ctx.page.drawText(subtitle, {
      x: MARGIN_X, y: ctx.y, size: 8, font: ctx.helv, color: TEXT_MUTED,
    });
    ctx.y -= 8;
  }
  // Underline
  ctx.page.drawLine({
    start: { x: MARGIN_X, y: ctx.y },
    end:   { x: PAGE_WIDTH - MARGIN_X, y: ctx.y },
    thickness: 1.5, color: ACCENT,
  });
  ctx.y -= 6;
}

function drawSubsectionTitle(ctx: RenderCtx, title: string) {
  ctx.y -= 4;
  ctx.page.drawText(title, {
    x: MARGIN_X, y: ctx.y, size: 12, font: ctx.helvB, color: TEXT_PRIMARY,
  });
  ctx.y -= 4;
  ctx.page.drawLine({
    start: { x: MARGIN_X, y: ctx.y },
    end:   { x: PAGE_WIDTH - MARGIN_X, y: ctx.y },
    thickness: 1, color: ACCENT,
  });
  ctx.y -= 14;
}

function drawTableHeader(ctx: RenderCtx, labels: string[], widths: number[]) {
  let x = MARGIN_X;
  for (let i = 0; i < labels.length; i++) {
    ctx.page.drawText(labels[i], {
      x: x + 2, y: ctx.y, size: 8, font: ctx.helvB, color: TEXT_MUTED,
    });
    x += widths[i];
  }
  ctx.y -= 12;
}

let _zebraToggle = false;

function drawProcessorRow(ctx: RenderCtx, label: string, subtotal: number) {
  _zebraToggle = false;
  ctx.page.drawRectangle({
    x: MARGIN_X, y: ctx.y - 4, width: CONTENT_WIDTH, height: 16,
    color: ACCENT_LIGHT,
  });
  ctx.page.drawText(label, {
    x: MARGIN_X + 4, y: ctx.y, size: 9.5, font: ctx.helvB, color: ACCENT,
  });
  const subStr = formatCurrency(subtotal);
  const subW = ctx.helvB.widthOfTextAtSize(subStr, 9.5);
  ctx.page.drawText(subStr, {
    x: PAGE_WIDTH - MARGIN_X - subW - 4, y: ctx.y, size: 9.5, font: ctx.helvB, color: ACCENT,
  });
  ctx.y -= 18;
}

function drawVerificationDataRow(ctx: RenderCtx, rowNum: number, ent: VerificationEntity) {
  if (_zebraToggle) {
    ctx.page.drawRectangle({
      x: MARGIN_X, y: ctx.y - 4, width: CONTENT_WIDTH, height: 14, color: ROW_ALT,
    });
  }
  _zebraToggle = !_zebraToggle;

  const cols: [string, number][] = [
    [String(rowNum), 22],
    [truncate(ent.entityName, 38), 220],
    [ent.formType, 50],
    [ent.loanNumber || '-', 60],
    [ent.completedAt, 70],
    [formatCurrency(ent.unitPrice), 60],
    [formatCurrency(ent.unitPrice), 60],
  ];
  let x = MARGIN_X;
  for (let i = 0; i < cols.length; i++) {
    const [text, w] = cols[i];
    const font = i === 6 ? ctx.helvB : ctx.helv;
    ctx.page.drawText(text, {
      x: x + 2, y: ctx.y, size: 9, font, color: TEXT_PRIMARY,
    });
    x += w;
  }
  ctx.y -= 14;
}

function drawMonitoringDataRow(ctx: RenderCtx, rowNum: number, item: MonitoringItem) {
  if (_zebraToggle) {
    ctx.page.drawRectangle({
      x: MARGIN_X, y: ctx.y - 4, width: CONTENT_WIDTH, height: 14, color: ROW_ALT,
    });
  }
  _zebraToggle = !_zebraToggle;

  const cols: [string, number, PDFFont][] = [
    [String(rowNum), 22, ctx.helv],
    [truncate(item.description, 50), 240, ctx.helv],
    [item.loanNumber || '-', 80, ctx.helv],
    [item.date, 70, ctx.helv],
    [formatCurrency(item.unitPrice), 60, ctx.helv],
    [formatCurrency(item.unitPrice), 60, ctx.helvB],
  ];
  let x = MARGIN_X;
  for (const [text, w, font] of cols) {
    ctx.page.drawText(text, { x: x + 2, y: ctx.y, size: 9, font, color: TEXT_PRIMARY });
    x += w;
  }
  ctx.y -= 14;
}

function drawSubtotalLine(ctx: RenderCtx, label: string, amount: number) {
  ctx.y -= 4;
  ctx.page.drawLine({
    start: { x: MARGIN_X, y: ctx.y + 8 },
    end:   { x: PAGE_WIDTH - MARGIN_X, y: ctx.y + 8 },
    thickness: 0.5, color: BORDER,
  });
  const amtStr = formatCurrency(amount);
  const labelW = ctx.helvB.widthOfTextAtSize(label, 10);
  const amtW = ctx.helvB.widthOfTextAtSize(amtStr, 10);
  ctx.page.drawText(label, {
    x: PAGE_WIDTH - MARGIN_X - amtW - 16 - labelW,
    y: ctx.y, size: 10, font: ctx.helv, color: TEXT_PRIMARY,
  });
  ctx.page.drawText(amtStr, {
    x: PAGE_WIDTH - MARGIN_X - amtW - 4,
    y: ctx.y, size: 10, font: ctx.helvB, color: TEXT_PRIMARY,
  });
  ctx.y -= 16;
}

function drawSummaryHeader(ctx: RenderCtx, input: InvoicePdfInput) {
  ctx.page.drawRectangle({
    x: 0, y: PAGE_HEIGHT - 60, width: PAGE_WIDTH, height: 60, color: NAVY,
  });
  ctx.page.drawText(`Invoice ${input.invoiceNumber} - Summary`, {
    x: MARGIN_X, y: PAGE_HEIGHT - 36, size: 16, font: ctx.helvB, color: rgb(1, 1, 1),
  });
  const right = `${input.client.name}  |  ${formatDateLong(input.invoiceDate)}`;
  const rightW = ctx.helv.widthOfTextAtSize(right, 10);
  ctx.page.drawText(right, {
    x: PAGE_WIDTH - MARGIN_X - rightW, y: PAGE_HEIGHT - 36,
    size: 10, font: ctx.helv, color: rgb(0.85, 0.88, 0.92),
  });
  ctx.y = PAGE_HEIGHT - 90;
}

function drawSummaryDataRow(ctx: RenderCtx, member: string, entities: number, subtotal: number) {
  if (_zebraToggle) {
    ctx.page.drawRectangle({
      x: MARGIN_X, y: ctx.y - 4, width: CONTENT_WIDTH, height: 14, color: ROW_ALT,
    });
  }
  _zebraToggle = !_zebraToggle;
  ctx.page.drawText(member, { x: MARGIN_X + 2, y: ctx.y, size: 10, font: ctx.helv, color: TEXT_PRIMARY });
  ctx.page.drawText(String(entities), { x: MARGIN_X + 322, y: ctx.y, size: 10, font: ctx.helv, color: TEXT_PRIMARY });
  const subStr = formatCurrency(subtotal);
  const subW = ctx.helvB.widthOfTextAtSize(subStr, 10);
  ctx.page.drawText(subStr, {
    x: PAGE_WIDTH - MARGIN_X - subW - 4, y: ctx.y, size: 10, font: ctx.helvB, color: TEXT_PRIMARY,
  });
  ctx.y -= 14;
}

function drawTotalDueBox(ctx: RenderCtx, breakdown: {
  verification: number;
  entityTranscripts: number;
  selfSigned8821: number;
  monitoring: number;
  total: number;
}) {
  const lines: [string, number][] = [];
  lines.push([`Tax Verification`, breakdown.verification]);
  if (breakdown.entityTranscripts > 0) lines.push([`Entity Transcripts`, breakdown.entityTranscripts]);
  if (breakdown.selfSigned8821 > 0) lines.push([`8821 Generation & Signature`, breakdown.selfSigned8821]);
  if (breakdown.monitoring > 0) lines.push([`Transcript Monitoring`, breakdown.monitoring]);

  const boxX = MARGIN_X + 80;
  const boxW = CONTENT_WIDTH - 160;
  const boxH = 26 + lines.length * 18 + 36;
  ctx.page.drawRectangle({
    x: boxX, y: ctx.y - boxH, width: boxW, height: boxH,
    color: rgb(0.97, 0.98, 0.99), borderColor: ACCENT, borderWidth: 1,
  });
  let y = ctx.y - 22;
  for (const [label, amt] of lines) {
    ctx.page.drawText(label, { x: boxX + 16, y, size: 10, font: ctx.helv, color: TEXT_PRIMARY });
    const amtStr = formatCurrency(amt);
    const amtW = ctx.helv.widthOfTextAtSize(amtStr, 10);
    ctx.page.drawText(amtStr, {
      x: boxX + boxW - 16 - amtW, y, size: 10, font: ctx.helv, color: TEXT_PRIMARY,
    });
    y -= 18;
  }
  // Separator
  ctx.page.drawLine({
    start: { x: boxX + 16, y: y + 4 }, end: { x: boxX + boxW - 16, y: y + 4 },
    thickness: 0.5, color: BORDER,
  });
  y -= 4;
  ctx.page.drawText('Total Due:', {
    x: boxX + 16, y: y - 14, size: 16, font: ctx.helvB, color: TEXT_PRIMARY,
  });
  const totalStr = formatCurrency(breakdown.total);
  const totalW = ctx.helvB.widthOfTextAtSize(totalStr, 18);
  ctx.page.drawText(totalStr, {
    x: boxX + boxW - 16 - totalW, y: y - 14, size: 18, font: ctx.helvB, color: ACCENT,
  });
  ctx.y -= boxH;
}

function drawPayLink(ctx: RenderCtx, payUrl: string) {
  const buttonW = 240;
  const buttonH = 36;
  const buttonX = (PAGE_WIDTH - buttonW) / 2;
  const buttonY = ctx.y - buttonH;
  ctx.page.drawRectangle({
    x: buttonX, y: buttonY, width: buttonW, height: buttonH,
    color: ACCENT,
  });
  const label = 'Pay Invoice via Mercury  >';
  const labelW = ctx.helvB.widthOfTextAtSize(label, 12);
  ctx.page.drawText(label, {
    x: buttonX + (buttonW - labelW) / 2, y: buttonY + 12,
    size: 12, font: ctx.helvB, color: rgb(1, 1, 1),
  });
  // Add link annotation. pdf-lib's annotation API is awkward; embed via raw dict.
  const linkAnnotation = ctx.pdf.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [buttonX, buttonY, buttonX + buttonW, buttonY + buttonH],
    Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: payUrl },
  });
  const linkRef = ctx.pdf.context.register(linkAnnotation);
  const annots = ctx.page.node.lookup(ctx.pdf.context.obj('Annots'));
  if (!annots) {
    ctx.page.node.set(ctx.pdf.context.obj('Annots'), ctx.pdf.context.obj([linkRef]));
  } else {
    (annots as any).push(linkRef);
  }
  // URL fallback below button
  ctx.page.drawText(payUrl, {
    x: MARGIN_X, y: buttonY - 14, size: 8, font: ctx.helv, color: TEXT_MUTED,
  });
  ctx.y = buttonY - 24;
}

function drawNoteBullet(ctx: RenderCtx, text: string) {
  ctx.page.drawText('*', {
    x: MARGIN_X, y: ctx.y, size: 11, font: ctx.helvB, color: ACCENT,
  });
  ctx.page.drawText(text, {
    x: MARGIN_X + 14, y: ctx.y, size: 9.5, font: ctx.helv, color: TEXT_PRIMARY,
  });
  ctx.y -= 14;
}

function drawPageFooter(ctx: RenderCtx) {
  ctx.page.drawRectangle({
    x: 0, y: 0, width: PAGE_WIDTH, height: 26, color: NAVY_DARK,
  });
  const text = `Rapidly Financial Inc  |  DBA ModernTax  |  moderntax.io  |  Page ${ctx.pageNumber}`;
  const w = ctx.helv.widthOfTextAtSize(text, 8);
  ctx.page.drawText(text, {
    x: (PAGE_WIDTH - w) / 2, y: 9, size: 8, font: ctx.helv, color: rgb(0.85, 0.88, 0.92),
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatCurrency(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDateLong(yyyymmdd: string): string {
  // "2026-05-01" → "May 1, 2026"
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  if (!y || !m || !d) return yyyymmdd;
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[m - 1]} ${d}, ${y}`;
}

function formatRange(input: InvoicePdfInput): string {
  return `${formatDateShort(input.billingPeriodStart)} - ${formatDateShort(input.billingPeriodEnd)}`;
}

function formatDateShort(yyyymmdd: string): string {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  if (!y || !m || !d) return yyyymmdd;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[m - 1]} ${d}, ${y}`;
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max - 1) + '...';
}
