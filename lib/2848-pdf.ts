/**
 * IRS Form 2848 (Power of Attorney and Declaration of Representative) generator.
 *
 * Companion to lib/8821-pdf.ts. Where the 8821 only grants *information access*
 * (a designee), the 2848 grants *representation* — so Part II is a Circular 230
 * declaration the representative signs at execution time.
 *
 * Per Matt (2026-06-20): forms must NOT name a specific individual designee.
 * The representative block is the generic ModernTax firm with a BLANK CAF
 * (the actual representing practitioner + their CAF/designation/license are
 * filled in at assignment/signing time, since they can change per case).
 *
 * The public/templates/2848.pdf template exposes clean, semantically-named
 * AcroForm fields (TaxpayerName, RepresentativesName1, CAFNumber1, Description1,
 * …), so unlike the 8821 we can fill by name directly — no coordinate overlays.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { PDFDocument } from 'pdf-lib';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Taxpayer2848 {
  name: string;
  address: string;            // full address; rendered into the TaxpayerAddress cell
  tin: string;                // raw or formatted; placed by tinKind
  tinKind: 'SSN' | 'EIN' | 'ITIN';
  phone?: string;
  /** Print name under the line-7 taxpayer signature (defaults to `name`). */
  printName?: string;
}

export interface Representative2848 {
  name: string;
  address: string;
  caf?: string;               // BLANK by default — varies by assigned practitioner
  ptin?: string;
  phone?: string;
  fax?: string;
}

export interface Act2848 {
  /** Description of Matter — e.g. "Income", "Employment", "Civil Penalty". */
  description: string;
  /** Tax Form Number — e.g. "1040", "941". */
  form: string;
  /** Year(s) or Period(s) — e.g. "2019-2024", "2020Q2-2021Q3". */
  years: string;
}

export interface Fill2848Options {
  taxpayer: Taxpayer2848;
  /** Defaults to the generic ModernTax representative (blank CAF). */
  representative?: Representative2848;
  /** Section 3 "Acts authorized" rows (max 3 render on the form). */
  acts: Act2848[];
  /** Line 5a additional acts. Defaults: access records via ISP = true. */
  additionalActs?: {
    accessRecords?: boolean;
    authorizeDisclosure?: boolean;
    substituteOrAdd?: boolean;
    signReturn?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Generic ModernTax representative — no named individual, blank CAF.
// The representing practitioner's CAF/PTIN + the Part II declaration
// (designation, jurisdiction, license, signature) are completed at signing.
// ---------------------------------------------------------------------------

export const MODERNTAX_REPRESENTATIVE: Representative2848 = {
  name: 'ModernTax Inc',
  address: '2 Embarcadero, 8th Floor, San Francisco, CA 94111',
  caf: '',          // intentionally blank — filled per assigned practitioner
  ptin: '',         // intentionally blank
  phone: '650-741-1085',
  fax: '415-900-4436',
};

function formatTin(tin: string, kind: Taxpayer2848['tinKind']): string {
  const d = (tin || '').replace(/\D/g, '');
  if (kind === 'EIN' && d.length === 9) return `${d.slice(0, 2)}-${d.slice(2)}`;
  if ((kind === 'SSN' || kind === 'ITIN') && d.length === 9) return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
  return tin;
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

/**
 * Generate a filled IRS Form 2848 PDF (pure JS, Vercel-compatible).
 * Taxpayer + representative + Section-3 acts are populated; Part II (the
 * representative's signed declaration) and the taxpayer signature are left
 * blank for execution. Returns a flattened Buffer.
 */
export async function generate2848PDF(options: Fill2848Options): Promise<Buffer> {
  const { taxpayer, acts } = options;
  const rep = options.representative || MODERNTAX_REPRESENTATIVE;
  const addl = { accessRecords: true, ...options.additionalActs };

  // Field map keyed by the template's short field names.
  const textValues: Record<string, string> = {
    TaxpayerName: taxpayer.name,
    TaxpayerAddress: taxpayer.address,
    TaxpayerTelephone: taxpayer.phone || '',
    PrintName: taxpayer.printName || taxpayer.name,

    RepresentativesName1: rep.name,
    RepresentativesAddress1: rep.address,
    CAFNumber1: rep.caf || '',
    PTIN1: rep.ptin || '',
    TelephoneNo1: rep.phone || '',
    FaxNo1: rep.fax || '',
  };
  // Taxpayer ID goes in the field matching its kind.
  const tin = formatTin(taxpayer.tin, taxpayer.tinKind);
  if (taxpayer.tinKind === 'EIN') textValues.TaxpayerIDEIN = tin;
  else if (taxpayer.tinKind === 'ITIN') textValues.TaxpayerIDITIN = tin;
  else textValues.TaxpayerIDSSN = tin;

  // Section 3 acts (up to 3 rows).
  acts.slice(0, 3).forEach((a, i) => {
    textValues[`Description${i + 1}`] = a.description;
    textValues[`TaxForm${i + 1}`] = a.form;
    textValues[`Years${i + 1}`] = a.years;
  });

  const checkValues: Record<string, boolean> = {
    AccessRecords: !!addl.accessRecords,
    AuthorizeDisclosure: !!addl.authorizeDisclosure,
    SubtituteOrAdd: !!addl.substituteOrAdd,   // template's spelling
    SignReturn: !!addl.signReturn,
  };

  const templateBytes = await readFile(path.join(process.cwd(), 'public', 'templates', '2848.pdf'));
  const pdfDoc = await PDFDocument.load(templateBytes);
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  if (fields.length === 0) {
    throw new Error('2848 template has no AcroForm fields readable by pdf-lib.');
  }

  let filled = 0;
  for (const field of fields) {
    const short = field.getName().split('.').pop()?.replace(/\[\d+\]$/, '') || field.getName();
    if (short in textValues) {
      try { form.getTextField(field.getName()).setText(textValues[short] || ''); filled++; } catch { /* not text */ }
    } else if (short in checkValues) {
      try {
        const cb = form.getCheckBox(field.getName());
        if (checkValues[short]) cb.check(); else cb.uncheck();
        filled++;
      } catch { /* not a checkbox */ }
    }
  }

  if (filled === 0) {
    throw new Error(`2848: no expected fields matched. Sample: ${fields.slice(0, 5).map(f => f.getName()).join(', ')}`);
  }

  try {
    form.flatten();
  } catch (err) {
    console.warn('[2848-pdf] flatten failed (non-fatal):', err instanceof Error ? err.message : err);
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}
