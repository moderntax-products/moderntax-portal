/**
 * PDF renderer for the Filing-Compliance / Tax Compliance Report (MOD-228).
 * Mirrors the four sections of the on-portal report (lib/compliance-report)
 * into a downloadable, underwriter-ready PDF — the artifact Tax Guard delivers.
 *
 * WinAnsi-safe (StandardFonts.Helvetica): all text runs through clean() so
 * dirty transcript / DB text (tabs, smart quotes, em-dashes, non-Latin-1)
 * never aborts the render.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { ComplianceReport } from './compliance-report';

const clean = (s: unknown): string =>
  String(s ?? '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[ \t]/g, ' ')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/[^\x20-\x7E\xA1-\xFF]/g, '?')
    .replace(/ {2,}/g, ' ')
    .trim();

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateStr = (iso: string | null) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '--');

const IA_LABEL: Record<string, string> = { none: 'None', good_standing: 'Good Standing', potential_default: 'Potential for Default' };
const BAND_LABEL: Record<string, string> = { low: 'Low Risk', moderate: 'Moderate Risk', elevated: 'Elevated Risk', high: 'High Risk' };

export interface ComplianceReportPdfMeta {
  entityName: string;
  tin: string | null;
  tidKind: string | null;
  clientName: string;
  loanNumber: string | null;
}

export async function generateComplianceReportPdf(
  meta: ComplianceReportPdfMeta,
  report: ComplianceReport,
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const navy = rgb(0.04, 0.10, 0.16);
  const muted = rgb(0.42, 0.45, 0.50);
  const danger = rgb(0.73, 0.11, 0.11);
  const green = rgb(0.06, 0.49, 0.30);
  const accent = rgb(0.0, 0.45, 0.62);
  const lightBg = rgb(0.96, 0.97, 0.99);

  const W = 612, H = 792, M = 50;
  let page = pdf.addPage([W, H]);
  let y = H - M;

  const newPage = () => { page = pdf.addPage([W, H]); y = H - M; };
  const ensure = (h: number) => { if (y - h < M) newPage(); };

  const text = (s: string, opts: { x?: number; size?: number; b?: boolean; color?: ReturnType<typeof rgb>; max?: number } = {}) => {
    const size = opts.size ?? 10;
    const f = opts.b ? bold : font;
    let line = clean(s);
    if (opts.max) { while (line.length > 1 && f.widthOfTextAtSize(line, size) > opts.max) line = line.slice(0, -1); }
    page.drawText(line, { x: opts.x ?? M, y, size, font: f, color: opts.color ?? navy });
  };
  const right = (s: string, xRight: number, opts: { size?: number; b?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
    const size = opts.size ?? 10;
    const f = opts.b ? bold : font;
    const str = clean(s);
    page.drawText(str, { x: xRight - f.widthOfTextAtSize(str, size), y, size, font: f, color: opts.color ?? navy });
  };

  // ── Header ──────────────────────────────────────────────────────────────
  text('Tax Compliance Report', { size: 20, b: true }); y -= 22;
  text(`${meta.entityName}  |  ${meta.clientName}${meta.loanNumber ? `  |  loan ${meta.loanNumber}` : ''}`, { size: 11, color: muted }); y -= 14;
  text(`${meta.tidKind || 'TIN'} ${meta.tin || '--'}  |  Generated from ${report.generatedFrom} IRS Account Transcript(s)`, { size: 9, color: muted }); y -= 22;

  // ── Section 2: Report Summary (scorecard) ───────────────────────────────
  const boxTop = y;
  page.drawRectangle({ x: M, y: boxTop - 70, width: W - 2 * M, height: 70, color: lightBg });
  // Risk score
  const scoreColor = report.summary.riskScore >= 80 ? green : report.summary.riskScore >= 35 ? rgb(0.85, 0.45, 0) : danger;
  page.drawText('TAX RISK SCORE', { x: M + 12, y: boxTop - 18, size: 8, font: bold, color: muted });
  page.drawText(`${report.summary.riskScore}`, { x: M + 12, y: boxTop - 48, size: 28, font: bold, color: scoreColor });
  page.drawText('/100', { x: M + 12 + bold.widthOfTextAtSize(`${report.summary.riskScore}`, 28) + 3, y: boxTop - 48, size: 12, font, color: muted });
  page.drawText(clean(BAND_LABEL[report.summary.riskBand]), { x: M + 12, y: boxTop - 62, size: 9, font: bold, color: scoreColor });
  // Summary metrics (2x2 to the right)
  const colX = M + 160;
  const cells: [string, string, ReturnType<typeof rgb>][] = [
    ['Total Liability', usd(report.summary.totalLiability), report.summary.totalLiability > 0 ? danger : navy],
    ['Civil Penalties', report.summary.totalCivilPenalties > 0 ? usd(report.summary.totalCivilPenalties) : 'None', report.summary.totalCivilPenalties > 0 ? danger : navy],
    ['Installment Agreement', IA_LABEL[report.summary.installmentAgreement], navy],
    ['Liability at Risk for Levy', usd(report.summary.liabilityAtRiskForLevy), report.summary.liabilityAtRiskForLevy > 0 ? danger : navy],
  ];
  cells.forEach((c, i) => {
    const cx = colX + (i % 2) * 195;
    const cy = boxTop - 20 - Math.floor(i / 2) * 30;
    page.drawText(clean(c[0]), { x: cx, y: cy, size: 7.5, font: bold, color: muted });
    page.drawText(clean(c[1]), { x: cx, y: cy - 13, size: 12, font: bold, color: c[2] });
  });
  y = boxTop - 70 - 22;

  // ── Section 1: Verify Client Information ────────────────────────────────
  ensure(70);
  text('1 - Verify Client Information', { size: 12, b: true, color: accent }); y -= 16;
  const info: [string, string][] = [
    ['Name on file', report.clientInfo.name || meta.entityName],
    ['TIN', report.clientInfo.tin || '--'],
    ['Form / Entity Type', report.clientInfo.formTypes.join(', ') || '--'],
    ['Earliest IRS Activity', dateStr(report.clientInfo.establishmentDate)],
  ];
  info.forEach((row, i) => {
    const cx = M + (i % 2) * 270;
    if (i % 2 === 0 && i > 0) y -= 28;
    page.drawText(clean(row[0]), { x: cx, y, size: 7.5, font: bold, color: muted });
    page.drawText(clean(row[1]), { x: cx, y: y - 12, size: 10, font, color: navy, ...(undefined as any) });
  });
  y -= 28;
  text(`Periods covered: ${report.clientInfo.yearsCovered.join(', ') || '--'}`, { size: 8, color: muted, max: W - 2 * M }); y -= 22;

  // ── Section 3: Tax Liability Details (table) ────────────────────────────
  ensure(40);
  text('3 - Tax Liability Details', { size: 12, b: true, color: accent }); y -= 16;
  // header row
  const cols = { period: M, filed: 245, liab: 335, civ: 415, lien: 470, levy: 532 };
  page.drawText('Form / Tax Year', { x: cols.period, y, size: 8, font: bold, color: muted });
  right('Return Filed', cols.liab - 5, { size: 8, b: true, color: muted });
  right('Liability', cols.civ - 5, { size: 8, b: true, color: muted });
  right('Civil Pen.', cols.lien - 5, { size: 8, b: true, color: muted });
  page.drawText('Lien', { x: cols.lien, y, size: 8, font: bold, color: muted });
  page.drawText('Levy', { x: cols.levy, y, size: 8, font: bold, color: muted });
  y -= 4;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: muted });
  y -= 12;
  if (report.liabilityDetail.length === 0) {
    text('No transcript activity found yet.', { size: 9, color: muted }); y -= 16;
  } else {
    for (const p of report.liabilityDetail) {
      ensure(14);
      page.drawText(clean(`${p.formType || '-'} ${p.label}`), { x: cols.period, y, size: 8.5, font, color: navy });
      const filedStr = p.filingStatus === 'filed' ? (p.returnFiledAmount != null ? usd(p.returnFiledAmount) : 'Filed') : p.filingStatus === 'unfiled' ? 'UNFILED' : '--';
      right(filedStr, cols.liab - 5, { size: 8.5, b: p.filingStatus === 'unfiled', color: p.filingStatus === 'filed' ? green : p.filingStatus === 'unfiled' ? danger : muted });
      right(p.liability > 0 ? usd(p.liability) : '$0.00', cols.civ - 5, { size: 8.5, b: p.liability > 0, color: p.liability > 0 ? danger : muted });
      const civStr = p.civilPenaltyStatus === 'assessed' ? usd(p.civilPenalty) : p.civilPenaltyStatus === 'none' ? 'None' : '--';
      right(civStr, cols.lien - 5, { size: 8, color: p.civilPenaltyStatus === 'assessed' ? danger : p.civilPenaltyStatus === 'none' ? green : muted });
      page.drawText(p.lienDate ? clean(dateStr(p.lienDate)) : '--', { x: cols.lien, y, size: 7.5, font, color: p.lienDate ? danger : muted });
      page.drawText(p.levyRiskDate ? clean(dateStr(p.levyRiskDate)) : '--', { x: cols.levy, y, size: 7.5, font, color: p.levyRiskDate ? danger : muted });
      y -= 13;
    }
  }
  y -= 12;

  // ── Section 4: Tax Compliance Overview ──────────────────────────────────
  ensure(50);
  text('4 - Tax Compliance Overview', { size: 12, b: true, color: accent }); y -= 16;
  text('Return Filing Status', { size: 8.5, b: true, color: muted }); y -= 13;
  for (const f of report.complianceOverview.filingStatus) {
    ensure(12);
    page.drawText(clean(`${f.formType || ''} ${f.label}`), { x: M + 6, y, size: 8.5, font, color: navy });
    const lbl = f.status === 'filed' ? 'Filed' : f.status === 'unfiled' ? 'UNFILED' : 'Not checked';
    right(lbl, W - M, { size: 8.5, b: f.status !== 'not_checked', color: f.status === 'filed' ? green : f.status === 'unfiled' ? danger : muted });
    y -= 12;
  }
  if (report.complianceOverview.unfiledReturns.length > 0) {
    y -= 4; ensure(14);
    text(`Unfiled returns: ${report.complianceOverview.unfiledReturns.join(', ')} - potential hidden liability; monitor closely.`, { size: 8, color: danger, max: W - 2 * M }); y -= 14;
  }
  if (report.complianceOverview.civilPenalties.length > 0) {
    y -= 6; ensure(16);
    text('Civil Penalties (per year)', { size: 8.5, b: true, color: muted }); y -= 13;
    for (const c of report.complianceOverview.civilPenalties) {
      ensure(12);
      page.drawText(clean(c.label), { x: M + 6, y, size: 8.5, font, color: navy });
      right(c.status === 'assessed' ? `${usd(c.amount)} assessed` : 'None', W - M, { size: 8.5, b: c.status === 'assessed', color: c.status === 'assessed' ? danger : green });
      y -= 12;
    }
  }

  // ── Footer ──────────────────────────────────────────────────────────────
  ensure(30); y -= 6;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: muted }); y -= 12;
  text('The Tax Risk Score is a funding-risk heuristic derived from liability, liens, levy notices, and filing compliance - not a credit score.', { size: 7, color: muted, max: W - 2 * M }); y -= 9;
  text('ModernTax Inc.  |  Sourced directly from IRS Account Transcripts.  |  Verify against source transcripts before a funding decision.', { size: 7, color: muted, max: W - 2 * M });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
