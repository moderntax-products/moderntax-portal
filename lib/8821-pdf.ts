/**
 * 8821 PDF Generator
 *
 * Fills IRS Form 8821 (Tax Information Authorization) PDF form fields
 * with taxpayer, designee, and tax information data.
 *
 * Uses pdf-lib (pure JS) so the function runs on Vercel's serverless
 * runtime — the previous pymupdf/Python-subprocess implementation
 * failed with "spawn python3 ENOENT" once deployed there (caught
 * 2026-05-18 when Matt clicked Regenerate 8821 w/ expert creds on
 * Joel Abernathy's assignment).
 *
 * The IRS 8821 templates in public/templates are hybrid PDFs — they
 * contain both XFA and AcroForm layers. pdf-lib can write the AcroForm
 * layer; the visual output is identical. After filling, we flatten the
 * form so the values render as static text (no longer editable).
 *
 * Two template types:
 *  - Individual (1040): Civil Penalties + Income, Form 1040/W-2, 2022-2026
 *  - Business (1065/1120/1120S): Full coverage matching Cal Statewide format
 *
 * Returns a filled PDF buffer ready for Dropbox Sign or download.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { PDFDocument } from 'pdf-lib';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DesigneeInfo {
  name: string;          // e.g. "LaTonya Holmes C/O ModernTax Inc"
  address: string;       // e.g. "2 Embarcadero, 2nd Floor"
  city: string;
  state: string;
  zip: string;
  caf: string;           // e.g. "0315-23541R"
  ptin: string;          // e.g. "0316-30210"
  phone: string;         // e.g. "650-741-1085"
  fax?: string;          // e.g. "415-900-4436"
}

export interface TaxpayerInfo {
  name: string;
  tin: string;           // SSN or EIN (formatted)
  address: string;       // Full address line
  phone?: string;
  signerName?: string;   // Section 6 "Print Name" (e.g. "Linda Oliver")
  signerTitle?: string;  // Section 6 "Title (if applicable)" (e.g. "Managing Member")
}

export interface Fill8821Options {
  taxpayer: TaxpayerInfo;
  designee: DesigneeInfo;
  formType: '1040' | '1065' | '1120' | '1120S' | '990' | '1041' | '941';
  /** Override Section 3 years (default: "2022-2026") */
  years?: string;
  /**
   * Optional: raw bytes of an expert-supplied pre-filled 8821 template
   * (designee + Section 3 already populated to the expert's preferences).
   * When provided, this replaces the default 8821-business-v2.pdf /
   * 8821-individual-v2.pdf template, and ONLY the taxpayer fields
   * (Section 1: f1_6, f1_7, f1_8) are overlaid. The designee preset
   * passed in `designee` is ignored — the template carries the expert's
   * actual designee block.
   *
   * Loaded by callers from Supabase storage path
   * `profiles.expert_template_8821_url` per the per-expert template
   * feature shipped 2026-05-18.
   */
  expertTemplateBytes?: Uint8Array | Buffer;
}

// ---------------------------------------------------------------------------
// Designee presets
// ---------------------------------------------------------------------------

export const DESIGNEES: Record<string, DesigneeInfo> = {
  // Generic ModernTax firm designee — no named individual (LaTonya removed
  // 2026-06-20 per Matt: "use generic ModernTax, leave CAF placeholder blank
  // as it can change"). NOTE: the CAF is intentionally NON-blank here — it
  // retains the ModernTax firm master CAF, because this default feeds the
  // taxpayer-SIGNED 8821 prefill in the lender flow, and a signed 8821 with a
  // blank designee CAF is rejected by the IRS. The per-case CAF still gets
  // overridden by the assigned expert's real CAF via buildDesigneeFromProfile.
  // (The 2848 generator DOES leave CAF blank — there the practitioner completes
  // it at signing in the Part II declaration.)
  default: {
    name: 'ModernTax Inc',
    address: '2 Embarcadero, 8th Floor',
    city: 'San Francisco',
    state: 'CA',
    zip: '94111',
    ptin: 'P01809554',
    caf: '0316-30210R',
    phone: '650-741-1085',
    fax: '415-900-4436',
  },
  parker: {
    name: 'Matthew Parker C/O ModernTax Inc',
    address: '2 Embarcadero, 2nd Floor',
    city: 'San Francisco',
    state: 'CA',
    zip: '94111',
    ptin: 'P01809554',
    caf: '0316-30210R',
    phone: '650-741-1085',
    fax: '415-900-4436',
  },
};

// ---------------------------------------------------------------------------
// Build designee from an expert's profile row
//
// Replaces the historical DESIGNEES preset lookup for the assigned-expert
// case. Profiles already store every cred we need (caf_number, ptin,
// phone_number, full_name, address). When an entity is assigned to an
// expert, the 8821 must list THAT expert as the designee — not whoever
// DESIGNEES.default points at — otherwise IRS rejects the call.
//
// Failure caught 2026-05-16: Joel Abernathy was assigned 4 entities with
// 8821s generated under DESIGNEES.default (LaTonya). Joel's profile had
// caf_number=null, ptin=null, phone_number=null — no creds had ever been
// entered. The 8821s in his queue were technically invalid for him to use.
// ---------------------------------------------------------------------------

export interface ExpertProfileForDesignee {
  full_name: string | null;
  caf_number: string | null;
  ptin: string | null;
  phone_number: string | null;
  fax_number?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip_code?: string | null;
}

/**
 * Build a DesigneeInfo from an expert's profile row. Throws if the
 * required IRS designee fields are missing — call `validateExpertDesigneeCreds()`
 * first if you want a friendlier error.
 *
 * Address/city/state/zip default to the shared ModernTax HQ if the expert
 * hasn't populated them — every expert operates under "C/O ModernTax Inc"
 * as the IRS designee mailing address.
 */
export function buildDesigneeFromProfile(profile: ExpertProfileForDesignee): DesigneeInfo {
  const missing = validateExpertDesigneeCreds(profile);
  if (missing.length > 0) {
    throw new Error(
      `Expert profile missing required IRS designee fields: ${missing.join(', ')}. ` +
      `Have the expert complete their profile at /expert/profile before assigning entities to them.`,
    );
  }
  const name = `${profile.full_name!.trim()} C/O ModernTax Inc`;
  return {
    name,
    address: (profile.address?.trim()) || '2 Embarcadero, 2nd Floor',
    city: (profile.city?.trim()) || 'San Francisco',
    state: (profile.state?.trim()) || 'CA',
    zip: (profile.zip_code?.trim()) || '94111',
    caf: profile.caf_number!.trim(),
    ptin: profile.ptin!.trim(),
    phone: profile.phone_number!.trim(),
    fax: (profile.fax_number?.trim()) || '415-900-4436',
  };
}

/**
 * Returns a list of field names that are missing/blank on the expert's
 * profile. Empty array means the profile is complete enough to be a
 * designee. Used by:
 *   · /api/admin/expert/assign — gate that blocks assignment when incomplete
 *   · components/AdminExpertAssign — UI warning before selection
 *   · app/expert/page — banner nudging the expert to complete their profile
 */
export function validateExpertDesigneeCreds(profile: ExpertProfileForDesignee): string[] {
  const missing: string[] = [];
  if (!profile.full_name?.trim())   missing.push('full_name');
  if (!profile.caf_number?.trim())  missing.push('caf_number');
  if (!profile.ptin?.trim())        missing.push('ptin');
  if (!profile.phone_number?.trim())missing.push('phone_number');
  return missing;
}

/** Secondary designee — always included as backup on every 8821 */
const BACKUP_DESIGNEE: DesigneeInfo = {
  name: 'ModernTax Inc C/O Matthew Parker',
  address: '2 Embarcadero, 2nd Floor',
  city: 'San Francisco',
  state: 'CA',
  zip: '94111',
  ptin: 'P01809554',
  caf: '0316-30210R',
  phone: '650-741-1085',
  fax: '415-900-4436',
};

// ---------------------------------------------------------------------------
// Section 3 standardized content
// ---------------------------------------------------------------------------

interface Section3Row {
  type: string;
  form: string;
  years: string;
  specific: string;
}

function getSection3Individual(years: string): Section3Row[] {
  return [
    { type: 'Civil Penalties, Income', form: '1040, W-2', years, specific: 'Federal Tax' },
  ];
}

function getSection3Business(years: string): Section3Row[] {
  // CRITICAL: column C (years) is a SINGLE-LINE field, 128pt wide ×
  // 12pt tall. Anything past ~21 chars truncates and the IRS rejects
  // the form because the year range is unclear (Joel Abernathy
  // 2026-05-26 — j&j mechanical 8821 showed "2022-20" because we'd
  // stuffed "1st, 2nd, 3rd, 4th quarters\n2022, 2023, 2024" into a
  // single-line cell that can only render the first line).
  //
  // Fix: drop the quarters-prefix line entirely. IRS already knows
  // 941 is quarterly from column B ("Form Number: 941/943/944/..."),
  // so saying "1st, 2nd, 3rd, 4th quarters" in column C is redundant
  // padding that breaks the years rendering. Now just the years list,
  // which fits the cell at standard font size.
  return [
    {
      type: 'Withholding/Civil Penalty/\nExcise Tax',
      form: '941/943/944/945/6672/\n720/8804/CIV PEN',
      years,
      specific: 'N/A',
    },
    { type: 'Unemployment/Heavy Use/\nCivil Penalty', form: '940/2290/CIV PEN', years, specific: 'N/A' },
    { type: 'Income', form: '1065/1120/1120S/990/1041', years, specific: 'N/A' },
  ];
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

/**
 * Generate a filled IRS Form 8821 PDF (pure JS, Vercel-compatible).
 *
 * Loads the AcroForm-bearing template from public/templates, fills
 * every named field via pdf-lib, flattens the form so the values
 * burn into the visual layer (no longer editable), and returns the
 * Buffer. Compatible with both Dropbox Sign upload (which wants an
 * unflattened form) and direct admin download (which wants flattened
 * so the borrower sees the values, not the empty fields).
 *
 * @returns Buffer containing the filled PDF
 */
export async function generate8821PDF(options: Fill8821Options): Promise<Buffer> {
  const { taxpayer, designee, formType, years = '2022-2026', expertTemplateBytes } = options;
  const isIndividual = formType === '1040';

  // Build field map — same field IDs the previous Python implementation
  // wrote to. IRS XFA forms expose the same field names on the AcroForm
  // side, so pdf-lib finds them under the same identifiers.
  const d1Addr = `${designee.name}\n${designee.address}, ${designee.city}, ${designee.state} ${designee.zip}`;
  const d2Addr = `${BACKUP_DESIGNEE.name}\n${BACKUP_DESIGNEE.address}, ${BACKUP_DESIGNEE.city}, ${BACKUP_DESIGNEE.state} ${BACKUP_DESIGNEE.zip}`;
  const rows = isIndividual ? getSection3Individual(years) : getSection3Business(years);

  // When using an expert's pre-filled template, ONLY the taxpayer fields
  // (Section 1) are overlaid — the designee block + Section 3 are already
  // baked into the template to the expert's preferences. When using the
  // default template, every field is filled.
  const fieldMap: Record<string, string> = expertTemplateBytes
    ? {
        // Section 1 only — taxpayer fields. Everything else lives in the template.
        'f1_6': `${taxpayer.name}\n${taxpayer.address}`,
        'f1_7': taxpayer.tin,
        'f1_8': taxpayer.phone || '',
        // Section 6 — signer print name + title
        'f1_32': taxpayer.signerName || '',
        'f1_33': taxpayer.signerTitle || '',
      }
    : {
        // Section 1: Taxpayer
        'f1_6': `${taxpayer.name}\n${taxpayer.address}`,
        'f1_7': taxpayer.tin,
        'f1_8': taxpayer.phone || '',

        // Section 2: Designee 1 (assigned expert)
        'f1_10': d1Addr,
        'f1_11': designee.caf,
        'f1_12': designee.ptin,
        'f1_13': designee.phone,
        'f1_14': designee.fax || '',

        // Section 2: Designee 2 (backup)
        'f1_15': d2Addr,
        'f1_16': BACKUP_DESIGNEE.caf,
        'f1_17': BACKUP_DESIGNEE.ptin,
        'f1_18': BACKUP_DESIGNEE.phone,
        'f1_19': BACKUP_DESIGNEE.fax || '',

        // Section 3 Row 1
        'f1_20': rows[0]?.type || '',
        'f1_21': rows[0]?.form || '',
        'f1_22': rows[0]?.years || '',
        'f1_23': rows[0]?.specific || '',

        // Section 3 Row 2
        'f1_24': rows[1]?.type || '',
        'f1_25': rows[1]?.form || '',
        'f1_26': rows[1]?.years || '',
        'f1_27': rows[1]?.specific || '',

        // Section 3 Row 3
        'f1_28': rows[2]?.type || '',
        'f1_29': rows[2]?.form || '',
        'f1_30': rows[2]?.years || '',
        'f1_31': rows[2]?.specific || '',

        // Section 6 — signer print name + title (pre-filled; borrower signs/dates)
        'f1_32': taxpayer.signerName || '',
        'f1_33': taxpayer.signerTitle || '',
      };

  let templateBytes: Uint8Array;
  if (expertTemplateBytes) {
    templateBytes = expertTemplateBytes instanceof Uint8Array
      ? expertTemplateBytes
      : new Uint8Array(expertTemplateBytes);
  } else {
    const templatePath = path.join(
      process.cwd(),
      'public',
      'templates',
      isIndividual ? '8821-individual-v2.pdf' : '8821-business-v2.pdf',
    );
    templateBytes = await readFile(templatePath);
  }
  const pdfDoc = await PDFDocument.load(templateBytes);
  const form = pdfDoc.getForm();
  const fields = form.getFields();

  if (fields.length === 0) {
    // Template has no AcroForm fields exposed to pdf-lib — it's XFA-only.
    // The pre-2026-05-18 Python implementation could handle this; the
    // pure-JS path cannot. Surface a clear error so we know to either
    // (a) regenerate the template as AcroForm via Adobe Acrobat, or
    // (b) implement coordinate-based text overlay as a fallback.
    throw new Error(
      `Template (${expertTemplateBytes ? 'expert-supplied' : isIndividual ? '8821-individual-v2.pdf' : '8821-business-v2.pdf'}) ` +
      `has no AcroForm fields readable by pdf-lib (likely XFA-only). ` +
      `Convert template to AcroForm in Adobe Acrobat ` +
      `(Tools → Prepare Form → recognize fields) or implement a coordinate-overlay fallback.`,
    );
  }

  // Fill every matching field. We iterate the form fields and match by
  // the SHORT name (the last segment of the dotted path, with [0] stripped)
  // — same logic the prior Python implementation used. This makes the
  // function tolerant of either naming convention pdf-lib exposes.
  let filledCount = 0;
  for (const field of fields) {
    const fullName = field.getName();
    const short = fullName.split('.').pop()?.replace(/\[0\]$/, '') || fullName;
    const value = fieldMap[short];
    if (value === undefined) continue;
    try {
      const textField = form.getTextField(fullName);
      textField.setText(value);
      filledCount += 1;
    } catch {
      // Field exists but isn't a text field (checkbox / radio) — skip.
    }
  }

  // Section 1 (taxpayer info) gap on our public/templates/8821-*.pdf files:
  // f1_6 (name+address), f1_7 (TIN), f1_8 (phone) exist as real widget
  // annotations with proper /Rect coords, but pdf-lib's getFields() filters
  // them out — likely because they're duplicate-annotation refs to the same
  // field. setText by full path silently fails, and even when /V gets set
  // pdf-lib's save() drops them on serialization. Until we either rebuild
  // the templates in Acrobat or fix it upstream in pdf-lib, draw the
  // Section 1 values directly onto the page at the template's exact field
  // rectangles (read from the template bytes 2026-05-20):
  //   f1_6 (name + address) Rect [ 36, 635.97, 344.85, 671.97 ]
  //   f1_7 (TIN)            Rect [ 345.6, 659.97, 576, 671.97 ]
  //   f1_8 (phone)          Rect [ 345.6, 635.97, 460.8, 647.97 ]
  // No drawing happens when an expert-supplied template is in use —
  // those carry their own Section 1 baked in.
  if (!expertTemplateBytes && (taxpayer.name || taxpayer.tin || taxpayer.phone || taxpayer.signerName || taxpayer.signerTitle)) {
    try {
      const { StandardFonts, rgb } = await import('pdf-lib');
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const page = pdfDoc.getPage(0);

      // Build the taxpayer block: name on line 1, then the address. Split on
      // NEWLINES only (NOT commas) and word-wrap each segment to the cell
      // width, so nothing is dropped. The previous comma-split + 3-line cap
      // silently dropped City/State/ZIP whenever the street contained a comma
      // (e.g. "42050 Kingston Lyons Dr, SE, Stayton, OR 97383" → only the
      // street + "SE" rendered). Callers may pass either a newline-formatted
      // address ("street\nCity, ST ZIP") or a comma-joined one — both now
      // render complete.
      const F6_SIZE = 9;
      const F6_MAXW = 300; // f1_6 cell is ~309pt wide (x 36→345); keep margin
      const rawSegments = [taxpayer.name, ...String(taxpayer.address || '').split('\n')]
        .map(s => s.trim()).filter(Boolean);
      const lines: string[] = [];
      for (const seg of rawSegments) {
        let cur = '';
        for (const word of seg.split(/\s+/)) {
          const test = cur ? `${cur} ${word}` : word;
          if (cur && font.widthOfTextAtSize(test, F6_SIZE) > F6_MAXW) { lines.push(cur); cur = word; }
          else cur = test;
        }
        if (cur) lines.push(cur);
      }

      // f1_6 cell: top=672, bottom=636 — 36pt. Stack up to 4 lines from the
      // top at 9pt line height (660 → 633) so name + a wrapped 2–3 line
      // address all fit without dropping City/State/ZIP.
      const f6_TOP = 660;
      const F6_LH = 9;
      for (let i = 0; i < Math.min(lines.length, 4); i++) {
        page.drawText(lines[i], { x: 40, y: f6_TOP - i * F6_LH, size: F6_SIZE, font, color: rgb(0, 0, 0) });
      }

      // f1_7 cell (TIN): single-line at top=672, bottom=660. Baseline ~662.
      if (taxpayer.tin) {
        page.drawText(taxpayer.tin, { x: 350, y: 662, size: 10, font, color: rgb(0, 0, 0) });
      }

      // f1_8 cell (phone): single-line at top=648, bottom=636. Baseline ~638.
      if (taxpayer.phone) {
        page.drawText(taxpayer.phone, { x: 350, y: 638, size: 10, font, color: rgb(0, 0, 0) });
      }

      // Section 6 — Print Name (f1_32, Rect ~[58,96,432,120]) + Title
      // (f1_33, Rect ~[432,96,554,120]). Like f1_6/7/8 these widgets aren't
      // filled via pdf-lib's named-field loop, so draw them at their cells.
      if (taxpayer.signerName) {
        page.drawText(taxpayer.signerName, { x: 62, y: 104, size: 9, font, color: rgb(0, 0, 0) });
      }
      if (taxpayer.signerTitle) {
        page.drawText(taxpayer.signerTitle, { x: 436, y: 104, size: 9, font, color: rgb(0, 0, 0) });
      }
    } catch (overlayErr) {
      console.warn('[8821-pdf] Section 1 overlay failed (non-fatal):', overlayErr instanceof Error ? overlayErr.message : overlayErr);
    }
  }

  if (filledCount === 0) {
    throw new Error(
      `pdf-lib found ${fields.length} fields but none matched the expected names (f1_6, f1_7, ...). ` +
      `Field name format may have changed. Sample names: ${fields.slice(0, 5).map(f => f.getName()).join(', ')}.`,
    );
  }

  // Flatten — values become part of the visual layer; the form is no
  // longer interactive. This is what we want for download-and-print and
  // for Dropbox Sign (signature placement happens on top of flat text).
  try {
    form.flatten();
  } catch (err) {
    // Some PDFs choke on flatten; non-fatal — values are still in the
    // form layer and most readers render them anyway.
    console.warn('[8821-pdf] form.flatten() failed (non-fatal):', err instanceof Error ? err.message : err);
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
