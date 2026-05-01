/**
 * MSA PDF Renderer
 *
 * Renders the standardized ModernTax Master Services Agreement to a clean
 * multi-page PDF using pdf-lib. Designed to be parameterized per customer
 * (selected tier, deposit clause, signer info) so a single template covers
 * Centerstone, TMC, future Tier-A signups, future Tier-C signups, etc.
 *
 * The text content lives inline as structured data (sections + paragraphs)
 * rather than parsed from markdown — keeps the rendering predictable for
 * legal review, and lets the tier-selection table render natively as a
 * pdf-lib drawn table rather than ASCII art.
 *
 * Output is portrait Letter, 1" margins, Helvetica 10pt body / 11pt section
 * headers / 18pt title. Word-wrap, page-break, and signature-block helpers
 * are inlined here rather than reused from invoice-pdf.ts because the layout
 * concerns are different (prose flow vs. table flow).
 */

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MsaPdfInput {
  /** Customer-specific data woven into the boilerplate. */
  customer: {
    name: string;
    address: string;
    noticeEmail: string;
    signerName: string;
    signerTitle: string;
  };
  /** Effective date of the agreement, displayed as "Month D, YYYY". */
  effectiveDate: string;          // ISO "2026-06-01"
  /** Selected pricing tier — drives which fee section is highlighted. */
  selectedTier: 'A' | 'B' | 'C';
  /** Net payment terms in days (Centerstone/TMC = 30, Cal Statewide MSA = 15). */
  netDays: number;
  /** The Section 2.3 deposit clause body (per-customer). Empty/null for Tier A or C. */
  depositClause: string | null;
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_X = 72;          // 1"
const MARGIN_TOP = 72;
const MARGIN_BOTTOM = 72;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

const COLOR_BODY = rgb(0.10, 0.10, 0.10);
const COLOR_MUTED = rgb(0.40, 0.40, 0.40);
const COLOR_ACCENT = rgb(0.16, 0.36, 0.62);
const COLOR_BORDER = rgb(0.85, 0.87, 0.90);
const COLOR_TIER_HIGHLIGHT = rgb(0.94, 0.97, 1.00);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function renderMsaPdf(input: MsaPdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`ModernTax Master Services Agreement — ${input.customer.name}`);
  pdf.setAuthor('ModernTax, Inc.');
  pdf.setProducer('moderntax.io');

  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvB = await pdf.embedFont(StandardFonts.HelveticaBold);
  const helvI = await pdf.embedFont(StandardFonts.HelveticaOblique);

  const ctx: Ctx = {
    pdf, helv, helvB, helvI,
    page: pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    y: PAGE_HEIGHT - MARGIN_TOP,
    pageNumber: 1,
    customer: input.customer,
  };

  // ---- Header band ----
  drawTitleBlock(ctx, input);

  // ---- Preamble ----
  drawSection(ctx, '', [
    boldedSentence('This Master Services Agreement (the "Agreement")', `is entered into as of ${formatDate(input.effectiveDate)} (the "Effective Date"), by and between ModernTax, Inc., a Delaware C-corporation with its principal place of business at 2 Embarcadero Center, 8th Floor, San Francisco, CA 94111 ("ModernTax"), and ${input.customer.name}, with its principal place of business at ${input.customer.address} ("Client"). ModernTax and Client are each a "Party" and collectively the "Parties."`),
    'This Agreement amends, restates, and supersedes any prior order form, statement of work, or master agreement between the Parties relating to the Services. Verifications, monitoring activity, and other Services delivered prior to the Effective Date remain governed by the prior agreement; Services delivered on or after the Effective Date are governed by this Agreement.',
  ]);

  // ---- Section 1 ----
  drawSection(ctx, '1. Services', [
    boldedSentence('1.1 Services.', 'ModernTax will provide Client with access to its IRS tax transcript verification platform (the "Services"), including: (a) digital IRS Form 8821 signature workflow; (b) pull of IRS account transcripts, return transcripts, record of account, business entity transcripts, and related records; (c) optional continuous account monitoring; and (d) web-based and API access to completed verification reports.'),
    boldedSentence('1.2 Platform Access.', 'ModernTax will provision user accounts at portal.moderntax.io for Client\'s authorized personnel. Client is responsible for maintaining the confidentiality of account credentials and for all activity conducted through its accounts.'),
    boldedSentence('1.3 Taxpayer Authorization.', 'Client shall obtain a duly executed IRS Form 8821 (or equivalent authorization) from each taxpayer whose information is the subject of a Service request, authorizing ModernTax (CAF 0316-30210R) as designee. Where Client has elected ModernTax-Prepared 8821 generation under Section 2.1, ModernTax will prepare and route the 8821 for taxpayer signature on Client\'s behalf.'),
    boldedSentence('1.4 Service Levels.', 'ModernTax targets delivery within 24-48 hours of request submission on IRS business days, subject to IRS system availability and the volume of authorizations in queue. Monitoring updates will be delivered as changes are detected on enrolled accounts.'),
  ]);

  // ---- Section 2 — Fees ----
  drawSection(ctx, '2. Fees and Payment', [
    boldedSentence('2.1 Service Tier Selection.', 'Client has selected the tier indicated below (one of three). The fee schedule for the selected tier governs all Services delivered during the term.'),
  ]);
  drawTierMatrix(ctx, input.selectedTier);
  drawTierDetails(ctx, 'A', input.selectedTier === 'A');
  drawTierDetails(ctx, 'B', input.selectedTier === 'B');
  drawTierDetails(ctx, 'C', input.selectedTier === 'C');

  drawSection(ctx, '', [
    boldedSentence('2.2 Pay-As-You-Go; No Minimums (Tiers A and B).', 'For Tiers A and B, this Agreement is billed on a usage basis. There is no monthly minimum commitment. Client is invoiced only for Services actually used during each billing period. Tier C carries the monthly Platform Fee as the only minimum commitment.'),
  ]);

  // 2.3 Deposit clause — render if a deposit clause is provided (Tier B
  // assignments + the customer-agnostic blank template). Tier A and Tier C
  // signed contracts pass null and skip this section entirely.
  if (input.depositClause) {
    drawSection(ctx, '', [
      boldedSentence('2.3 Onboarding Deposit (Tier B).', input.depositClause),
    ]);
  }

  drawSection(ctx, '', [
    boldedSentence('2.4 Billing Cycle.', `ModernTax will invoice Client on or about the first (1st) calendar day of each month for Services delivered during the preceding calendar month. Each invoice is accompanied by an itemized breakdown showing every entity, the requesting team member, and the rate applied. Invoices are due net ${input.netDays} days from the invoice date.`),
    boldedSentence('2.5 Payment Method.', 'Invoices will be delivered electronically through ModernTax\'s billing partner (Mercury) to a billing contact designated by Client. Payment may be made by ACH transfer or check. Client may enroll in Mercury auto-pay from any invoice\'s pay page; auto-pay applies to all subsequent invoices until cancelled.'),
    boldedSentence('2.6 Unsuccessful Pulls.', 'No charge applies to verification requests that fail due to IRS system error, invalid 8821, or absence of an account on file.'),
    boldedSentence('2.7 Late Payments.', 'Amounts not paid when due accrue interest at the lesser of 1.5% per month or the maximum rate permitted by law, from the due date until paid.'),
    boldedSentence('2.8 Taxes.', 'Fees are exclusive of all taxes. Client is responsible for all sales, use, and similar taxes arising from the Services, excluding taxes on ModernTax\'s net income.'),
    boldedSentence('2.9 Price Changes.', 'ModernTax may adjust Services pricing upon thirty (30) days\' prior written notice. Adjusted pricing applies only to Services delivered after the effective date of the change.'),
  ]);

  // ---- Section 3 ----
  drawSection(ctx, '3. Term and Termination', [
    boldedSentence('3.1 Term.', 'This Agreement commences on the Effective Date and continues month-to-month until terminated as set forth below.'),
    boldedSentence('3.2 Termination for Convenience.', 'Either Party may terminate this Agreement at any time upon thirty (30) days\' prior written notice to the other Party. Services accrued through the effective date of termination remain payable.'),
    boldedSentence('3.3 Termination for Cause.', 'Either Party may terminate this Agreement immediately upon written notice if the other Party materially breaches this Agreement and fails to cure such breach within fifteen (15) days of receiving written notice.'),
    boldedSentence('3.4 Effect of Termination.', 'Upon termination, Client\'s access to the ModernTax platform will be deactivated. Client may request export of its verification reports within thirty (30) days of termination. Sections 4 (Confidentiality), 5 (Data Protection), 7 (Limitation of Liability), 8 (Indemnification), and 9 (General) survive termination.'),
  ]);

  // ---- Section 4 ----
  drawSection(ctx, '4. Confidentiality', [
    boldedSentence('4.1 Definition.', '"Confidential Information" means any non-public business, technical, or financial information disclosed by one Party to the other in connection with this Agreement, whether or not marked as confidential, that a reasonable person would understand to be confidential.'),
    boldedSentence('4.2 Obligations.', 'Each Party shall: (a) use the other\'s Confidential Information solely to perform under this Agreement; (b) protect it with the same degree of care it uses for its own confidential information (and in no event less than a reasonable standard of care); and (c) not disclose it to any third party except to employees, advisors, or contractors bound by confidentiality obligations at least as protective as those herein.'),
    boldedSentence('4.3 Exclusions.', 'Confidential Information does not include information that is: (a) publicly known through no fault of the receiving Party; (b) already known to the receiving Party without restriction; (c) independently developed without reference to the other Party\'s information; or (d) required to be disclosed by law or court order, provided prompt written notice is given to the disclosing Party where permitted.'),
  ]);

  // ---- Section 5 ----
  drawSection(ctx, '5. Data Protection and Security', [
    boldedSentence('5.1 Taxpayer Data.', 'ModernTax handles taxpayer information obtained in the course of providing the Services in accordance with IRS regulations, the Gramm-Leach-Bliley Act, applicable state data protection laws, and ModernTax\'s published Security Practices. ModernTax maintains a SOC 2 Type II attestation.'),
    boldedSentence('5.2 Use Limitations.', 'ModernTax will process taxpayer data solely to provide the Services to Client and for ModernTax\'s internal operations related to the Services. ModernTax will not sell taxpayer data or use it for advertising.'),
    boldedSentence('5.3 Security Measures.', 'ModernTax implements administrative, physical, and technical safeguards designed to protect taxpayer data against unauthorized access, disclosure, or destruction, including encryption in transit and at rest, role-based access controls, and logging and monitoring.'),
    boldedSentence('5.4 Incident Notification.', 'ModernTax will notify Client without undue delay, and in any event within seventy-two (72) hours, after becoming aware of any unauthorized access to or disclosure of Client\'s Confidential Information or taxpayer data.'),
  ]);

  // ---- Section 6 ----
  drawSection(ctx, '6. Representations and Warranties', [
    boldedSentence('6.1 Mutual.', 'Each Party represents and warrants that: (a) it has full corporate power and authority to enter into and perform this Agreement; and (b) its execution and performance will not violate any other agreement to which it is bound.'),
    boldedSentence('6.2 Client.', 'Client represents and warrants that it has obtained, or will obtain prior to each Service request, all authorizations required under applicable law from each taxpayer whose information is the subject of a request, including a valid IRS Form 8821 naming ModernTax as designee.'),
    boldedSentence('6.3 Services Warranty.', 'ModernTax will perform the Services in a professional and workmanlike manner consistent with generally accepted industry standards. As Client\'s sole and exclusive remedy for breach of the foregoing warranty, ModernTax will re-perform the non-conforming Services at no additional charge.'),
    boldedSentence('6.4 Disclaimer.', 'EXCEPT AS EXPRESSLY SET FORTH HEREIN, THE SERVICES ARE PROVIDED "AS IS." MODERNTAX DISCLAIMS ALL OTHER WARRANTIES, EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. MODERNTAX DOES NOT WARRANT THAT THE SERVICES WILL BE UNINTERRUPTED, ERROR-FREE, OR THAT THE IRS WILL PROCESS EVERY REQUEST; IRS SYSTEMS AND ACCEPTANCE ARE OUTSIDE MODERNTAX\'S CONTROL.'),
  ]);

  // ---- Section 7 ----
  drawSection(ctx, '7. Limitation of Liability', [
    boldedSentence('7.1 Cap.', 'EXCEPT FOR LIABILITY ARISING FROM A PARTY\'S BREACH OF SECTION 4 (CONFIDENTIALITY), INDEMNIFICATION OBLIGATIONS UNDER SECTION 8, OR GROSS NEGLIGENCE OR WILLFUL MISCONDUCT, EACH PARTY\'S TOTAL CUMULATIVE LIABILITY UNDER THIS AGREEMENT WILL NOT EXCEED THE FEES PAID BY CLIENT TO MODERNTAX DURING THE TWELVE (12) MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM.'),
    boldedSentence('7.2 Exclusions.', 'IN NO EVENT WILL EITHER PARTY BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS OR LOST REVENUE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.'),
  ]);

  // ---- Section 8 ----
  drawSection(ctx, '8. Indemnification', [
    boldedSentence('8.1 By ModernTax.', 'ModernTax will defend and indemnify Client against any third-party claim alleging that the Services, as provided by ModernTax and used in accordance with this Agreement, infringe any U.S. patent, copyright, or trademark, and will pay damages finally awarded or settlement amounts agreed to by ModernTax.'),
    boldedSentence('8.2 By Client.', 'Client will defend and indemnify ModernTax against any third-party claim arising from: (a) Client\'s failure to obtain required taxpayer authorizations; or (b) Client\'s misuse of Services or data provided through the Services in violation of law or this Agreement.'),
    boldedSentence('8.3 Procedure.', 'The indemnified Party shall: (a) promptly notify the indemnifying Party in writing; (b) grant the indemnifying Party sole control of the defense and any settlement; and (c) provide reasonable cooperation, at the indemnifying Party\'s expense.'),
  ]);

  // ---- Section 9 ----
  drawSection(ctx, '9. General', [
    boldedSentence('9.1 Independent Contractors.', 'The Parties are independent contractors. Nothing in this Agreement creates any agency, partnership, joint venture, or employment relationship.'),
    boldedSentence('9.2 Assignment.', 'Neither Party may assign this Agreement without the other\'s prior written consent, except that either Party may assign this Agreement to a successor in connection with a merger, acquisition, or sale of substantially all of its assets.'),
    boldedSentence('9.3 Governing Law.', 'This Agreement is governed by the laws of the State of Delaware, without regard to conflict-of-laws principles. The Parties consent to the exclusive jurisdiction of state and federal courts located in the State of Delaware for any dispute arising out of or relating to this Agreement.'),
    boldedSentence('9.4 Notices.', `All notices must be in writing and delivered by email with read confirmation or by overnight courier to the addresses set forth above (or to matt@moderntax.io for ModernTax and ${input.customer.noticeEmail} for Client). Notices are effective upon receipt.`),
    boldedSentence('9.5 Force Majeure.', 'Neither Party will be liable for any failure or delay in performance caused by events beyond its reasonable control, including acts of God, natural disasters, war, terrorism, labor disputes, governmental action, or failures of the internet or IRS systems.'),
    boldedSentence('9.6 Severability; Waiver.', 'If any provision is held unenforceable, the remaining provisions remain in full force. No waiver of any breach is effective unless in writing, and no waiver constitutes a waiver of any subsequent breach.'),
    boldedSentence('9.7 Entire Agreement; Amendment.', 'This Agreement constitutes the entire agreement between the Parties regarding the subject matter and supersedes all prior agreements. Amendments must be in writing and signed by both Parties.'),
    boldedSentence('9.8 Counterparts; Electronic Signatures.', 'This Agreement may be executed in counterparts, including by electronic signature, each of which is deemed an original and together constitute one instrument.'),
  ]);

  // ---- Signature block ----
  drawSignatureBlock(ctx, input);

  // Footer on every page
  applyFooters(pdf, helv);

  return pdf.save();
}

// ---------------------------------------------------------------------------
// Render context + helpers
// ---------------------------------------------------------------------------

interface Ctx {
  pdf: PDFDocument;
  page: PDFPage;
  helv: PDFFont;
  helvB: PDFFont;
  helvI: PDFFont;
  y: number;
  pageNumber: number;
  customer: MsaPdfInput['customer'];
}

interface Span { text: string; bold?: boolean; italic?: boolean; }

/** Sentence with the leading clause bolded — used for all "X.Y Heading. Body..." paragraphs. */
function boldedSentence(boldPart: string, rest: string): Span[] {
  return [{ text: boldPart + ' ', bold: true }, { text: rest }];
}

function drawTitleBlock(ctx: Ctx, input: MsaPdfInput) {
  const title = 'MASTER SERVICES AGREEMENT';
  const titleSize = 16;
  const w = ctx.helvB.widthOfTextAtSize(title, titleSize);
  ctx.page.drawText(title, {
    x: (PAGE_WIDTH - w) / 2, y: ctx.y, size: titleSize, font: ctx.helvB, color: COLOR_BODY,
  });
  ctx.y -= 8;
  const sub = `Between ModernTax, Inc. and ${input.customer.name}`;
  const subSize = 10;
  const subW = ctx.helv.widthOfTextAtSize(sub, subSize);
  ctx.page.drawText(sub, {
    x: (PAGE_WIDTH - subW) / 2, y: ctx.y - 8, size: subSize, font: ctx.helvI, color: COLOR_MUTED,
  });
  ctx.y -= 22;
  ctx.page.drawLine({
    start: { x: MARGIN_X, y: ctx.y }, end: { x: PAGE_WIDTH - MARGIN_X, y: ctx.y },
    thickness: 0.7, color: COLOR_ACCENT,
  });
  ctx.y -= 22;
}

function drawSection(ctx: Ctx, heading: string, paragraphs: (string | Span[])[]) {
  if (heading) {
    ensureRoom(ctx, 28);
    ctx.y -= 8;
    ctx.page.drawText(heading, {
      x: MARGIN_X, y: ctx.y, size: 12, font: ctx.helvB, color: COLOR_BODY,
    });
    ctx.y -= 14;
  }
  for (const p of paragraphs) {
    drawParagraph(ctx, typeof p === 'string' ? [{ text: p }] : p);
    ctx.y -= 6; // paragraph spacing
  }
}

/** Word-wrap + flow a span sequence as a paragraph, breaking pages as needed. */
function drawParagraph(ctx: Ctx, spans: Span[]) {
  const fontSize = 9.5;
  const lineHeight = 12.5;
  const maxWidth = CONTENT_WIDTH;

  // Tokenize into words preserving span style.
  const words: { text: string; font: PDFFont; bold: boolean }[] = [];
  for (const span of spans) {
    const f = span.bold ? ctx.helvB : (span.italic ? ctx.helvI : ctx.helv);
    const parts = span.text.split(/(\s+)/);
    for (const p of parts) {
      if (p.length === 0) continue;
      words.push({ text: p, font: f, bold: !!span.bold });
    }
  }

  // Group words into lines respecting max width.
  let line: typeof words = [];
  let lineW = 0;
  const flushLine = () => {
    if (line.length === 0) return;
    ensureRoom(ctx, lineHeight);
    let x = MARGIN_X;
    // Trim leading whitespace on a wrapped line for cleaner left edge.
    while (line.length && /^\s+$/.test(line[0].text)) line.shift();
    for (const w of line) {
      ctx.page.drawText(w.text, {
        x, y: ctx.y, size: fontSize, font: w.font, color: COLOR_BODY,
      });
      x += w.font.widthOfTextAtSize(w.text, fontSize);
    }
    ctx.y -= lineHeight;
    line = []; lineW = 0;
  };

  for (const w of words) {
    const wWidth = w.font.widthOfTextAtSize(w.text, fontSize);
    if (lineW + wWidth > maxWidth && line.length > 0) {
      flushLine();
    }
    line.push(w);
    lineW += wWidth;
  }
  flushLine();
}

function drawTierMatrix(ctx: Ctx, selected: 'A' | 'B' | 'C') {
  ensureRoom(ctx, 110);
  ctx.y -= 4;
  const headers = ['', 'Tier', 'Verification', 'Onboarding', 'Monthly', 'Other-Fee Discount'];
  const widths = [22, 110, 80, 90, 70, 96];

  // Header row
  let x = MARGIN_X;
  for (let i = 0; i < headers.length; i++) {
    ctx.page.drawText(headers[i], {
      x: x + 3, y: ctx.y, size: 8, font: ctx.helvB, color: COLOR_MUTED,
    });
    x += widths[i];
  }
  ctx.y -= 12;
  ctx.page.drawLine({
    start: { x: MARGIN_X, y: ctx.y + 4 }, end: { x: PAGE_WIDTH - MARGIN_X, y: ctx.y + 4 },
    thickness: 0.5, color: COLOR_BORDER,
  });

  const rows: { tier: 'A' | 'B' | 'C'; cells: string[] }[] = [
    { tier: 'A', cells: ['', 'A. Pay-As-You-Go', '$79.98 / TIN', 'None', 'None', 'None'] },
    { tier: 'B', cells: ['', 'B. Deposit / Onboarding', '$59.98 / TIN', '$2,500 deposit', 'None', 'None'] },
    { tier: 'C', cells: ['', 'C. Platform / API', '$39.99 / TIN', 'None', '$2,500 / mo', '20% off other fees'] },
  ];
  for (const row of rows) {
    const isSel = row.tier === selected;
    if (isSel) {
      ctx.page.drawRectangle({
        x: MARGIN_X, y: ctx.y - 4, width: CONTENT_WIDTH, height: 18,
        color: COLOR_TIER_HIGHLIGHT,
      });
    }
    let xx = MARGIN_X;
    // Selection check mark in column 0
    const checkMark = isSel ? '[X]' : '[ ]';
    ctx.page.drawText(checkMark, {
      x: xx + 3, y: ctx.y, size: 9.5, font: ctx.helvB, color: isSel ? COLOR_ACCENT : COLOR_MUTED,
    });
    xx += widths[0];
    for (let i = 1; i < row.cells.length; i++) {
      ctx.page.drawText(row.cells[i], {
        x: xx + 3, y: ctx.y, size: 9, font: i === 1 ? ctx.helvB : ctx.helv, color: COLOR_BODY,
      });
      xx += widths[i];
    }
    ctx.y -= 18;
  }
  ctx.y -= 4;
}

function drawTierDetails(ctx: Ctx, tier: 'A' | 'B' | 'C', isSelected: boolean) {
  const lineHeight = 12.5;
  ensureRoom(ctx, 80);
  ctx.y -= 6;

  const heading = tier === 'A'
    ? '2.1.A  Tier A - Pay-As-You-Go (PAYG)'
    : tier === 'B'
      ? '2.1.B  Tier B - Deposit / Onboarding'
      : '2.1.C  Tier C - Platform / API Access';

  ctx.page.drawText(heading + (isSelected ? '   <<<  SELECTED' : ''), {
    x: MARGIN_X, y: ctx.y, size: 10.5, font: ctx.helvB,
    color: isSelected ? COLOR_ACCENT : COLOR_BODY,
  });
  ctx.y -= 14;

  // Fee table for this tier
  const fees = tier === 'A' ? [
    ['IRS Transcript Verification (TRT + ROA, 4 yrs)', 'per TIN', '$79.98'],
    ['Re-Orders (repeat pulls on the same TIN)', 'per pull', '$79.98'],
    ['Entity Transcript Add-On', 'per pull', '$19.99'],
    ['ModernTax-Prepared 8821 Generation', 'per entity', '$10.00'],
    ['Account Monitoring', 'per TIN per month', '$25.00'],
  ] : tier === 'B' ? [
    ['IRS Transcript Verification (TRT + ROA, 4 yrs)', 'per TIN', '$59.98'],
    ['Re-Orders (repeat pulls on the same TIN)', 'per pull', '$59.98'],
    ['Entity Transcript Add-On', 'per pull', '$19.99'],
    ['ModernTax-Prepared 8821 Generation', 'per entity', '$10.00'],
    ['Account Monitoring', 'per TIN per month', '$25.00'],
  ] : [
    ['IRS Transcript Verification (TRT + ROA, 4 yrs)', 'per TIN', '$39.99'],
    ['Re-Orders (repeat pulls on the same TIN)', 'per pull', '$39.99'],
    ['Entity Transcript Add-On (20% off list)', 'per pull', '$15.99'],
    ['ModernTax-Prepared 8821 Generation (20% off list)', 'per entity', '$8.00'],
    ['Account Monitoring (20% off list)', 'per TIN per month', '$20.00'],
    ['Platform / API Access (monthly subscription)', 'per month', '$2,500.00'],
  ];

  for (const row of fees) {
    ensureRoom(ctx, lineHeight);
    ctx.page.drawText(row[0], { x: MARGIN_X + 8, y: ctx.y, size: 9, font: ctx.helv, color: COLOR_BODY });
    ctx.page.drawText(row[1], { x: MARGIN_X + 280, y: ctx.y, size: 9, font: ctx.helv, color: COLOR_MUTED });
    const priceW = ctx.helvB.widthOfTextAtSize(row[2], 9);
    ctx.page.drawText(row[2], { x: PAGE_WIDTH - MARGIN_X - priceW - 4, y: ctx.y, size: 9, font: ctx.helvB, color: COLOR_BODY });
    ctx.y -= lineHeight;
  }

  if (tier === 'C') {
    ctx.y -= 6;
    drawParagraph(ctx, [
      { text: 'Tier C Platform Fee includes: ', bold: true },
      { text: '24/7 Customer Success access (dedicated Slack channel + named CSM), real-time transcript delivery feed (webhooks, API push), compliance reporting suite (CRITICAL/WARNING flag rollups, exposure dashboards), loan-package PDF templates and white-label cover sheets, direct REST API access, API key management with role-based access, priority queue placement within the standard 24-48 hour SLA, and priority IRS PPS escalation when transcripts are blocked. The Platform Fee is billed monthly on the first of each month for the upcoming calendar month and is non-refundable for partial months.' },
    ]);
  }

  ctx.y -= 6;
}

function drawSignatureBlock(ctx: Ctx, input: MsaPdfInput) {
  ensureRoom(ctx, 160);
  ctx.y -= 14;
  ctx.page.drawText('IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date.', {
    x: MARGIN_X, y: ctx.y, size: 9.5, font: ctx.helvB, color: COLOR_BODY,
  });
  ctx.y -= 28;

  const colW = (CONTENT_WIDTH - 24) / 2;
  const leftX = MARGIN_X;
  const rightX = MARGIN_X + colW + 24;

  // Heading row
  ctx.page.drawText('ModernTax, Inc.', { x: leftX, y: ctx.y, size: 10, font: ctx.helvB, color: COLOR_BODY });
  ctx.page.drawText(input.customer.name, { x: rightX, y: ctx.y, size: 10, font: ctx.helvB, color: COLOR_BODY });
  ctx.y -= 30;

  // Signature line
  drawSigField(ctx, leftX, ctx.y, colW, 'Signature');
  drawSigField(ctx, rightX, ctx.y, colW, 'Signature');
  ctx.y -= 20;

  // Name
  ctx.page.drawText(`Name: Matthew Parker`, { x: leftX, y: ctx.y, size: 9.5, font: ctx.helv, color: COLOR_BODY });
  ctx.page.drawText(`Name: ${input.customer.signerName}`, { x: rightX, y: ctx.y, size: 9.5, font: ctx.helv, color: COLOR_BODY });
  ctx.y -= 14;

  // Title
  ctx.page.drawText(`Title: Founder & Chief Executive Officer`, { x: leftX, y: ctx.y, size: 9.5, font: ctx.helv, color: COLOR_BODY });
  ctx.page.drawText(`Title: ${input.customer.signerTitle}`, { x: rightX, y: ctx.y, size: 9.5, font: ctx.helv, color: COLOR_BODY });
  ctx.y -= 14;

  // Date
  ctx.page.drawText('Date: ____________________', { x: leftX, y: ctx.y, size: 9.5, font: ctx.helv, color: COLOR_BODY });
  ctx.page.drawText('Date: ____________________', { x: rightX, y: ctx.y, size: 9.5, font: ctx.helv, color: COLOR_BODY });
}

function drawSigField(ctx: Ctx, x: number, y: number, w: number, label: string) {
  ctx.page.drawLine({
    start: { x, y: y + 0 }, end: { x: x + w, y: y + 0 }, thickness: 0.5, color: COLOR_BORDER,
  });
  ctx.page.drawText(label, { x, y: y - 12, size: 8, font: ctx.helv, color: COLOR_MUTED });
}

function ensureRoom(ctx: Ctx, needed: number) {
  if (ctx.y - needed < MARGIN_BOTTOM + 16) {
    ctx.pageNumber += 1;
    ctx.page = ctx.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    ctx.y = PAGE_HEIGHT - MARGIN_TOP;
  }
}

function applyFooters(pdf: PDFDocument, helv: PDFFont) {
  const total = pdf.getPageCount();
  pdf.getPages().forEach((page, idx) => {
    const text = `ModernTax, Inc.   |   Master Services Agreement   |   Page ${idx + 1} of ${total}`;
    const w = helv.widthOfTextAtSize(text, 8);
    page.drawText(text, {
      x: (PAGE_WIDTH - w) / 2, y: 36, size: 8, font: helv, color: COLOR_MUTED,
    });
  });
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[m - 1]} ${d}, ${y}`;
}
