/**
 * 8821 PDF Generator
 *
 * Fills IRS Form 8821 (Tax Information Authorization) PDF form fields
 * with taxpayer, designee, and tax information data.
 *
 * Uses pymupdf (fitz) via Python subprocess to handle XFA form fields
 * that pdf-lib cannot write to.
 *
 * Two template types:
 *  - Individual (1040): Civil Penalties + Income, Form 1040/W-2, 2022-2026
 *  - Business (1065/1120/1120S): Full coverage matching Cal Statewide format
 *
 * Returns a filled PDF buffer ready for Dropbox Sign or download.
 */

import { execFile } from 'child_process';
import { readFile, writeFile, unlink } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import os from 'os';

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
}

export interface Fill8821Options {
  taxpayer: TaxpayerInfo;
  designee: DesigneeInfo;
  formType: '1040' | '1065' | '1120' | '1120S' | '990' | '1041' | '941';
  /** Override Section 3 years (default: "2022-2026") */
  years?: string;
}

// ---------------------------------------------------------------------------
// Designee presets
// ---------------------------------------------------------------------------

export const DESIGNEES: Record<string, DesigneeInfo> = {
  default: {
    name: 'LaTonya Holmes C/O ModernTax Inc',
    address: '2 Embarcadero, 2nd Floor',
    city: 'San Francisco',
    state: 'CA',
    zip: '94111',
    ptin: '0316-30210',
    caf: '0315-23541R',
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
  return [
    {
      type: 'Withholding/Civil Penalty/\nExcise Tax',
      form: '941/943/944/945/6672/\n720/8804/CIV PEN',
      years: `1st, 2nd, 3rd, 4th quarters\n${years}`,
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
 * Generate a filled IRS Form 8821 PDF.
 *
 * Uses pymupdf via Python subprocess to write XFA form fields.
 *
 * @returns Buffer containing the filled PDF
 */
export async function generate8821PDF(options: Fill8821Options): Promise<Buffer> {
  const { taxpayer, designee, formType, years = '2022-2026' } = options;
  const isIndividual = formType === '1040';

  const templatePath = path.join(process.cwd(), 'public', 'templates',
    isIndividual ? '8821-individual-v2.pdf' : '8821-business-v2.pdf');

  // Build field map for pymupdf
  const d1Addr = `${designee.name}\n${designee.address}, ${designee.city}, ${designee.state} ${designee.zip}`;
  const d2Addr = `${BACKUP_DESIGNEE.name}\n${BACKUP_DESIGNEE.address}, ${BACKUP_DESIGNEE.city}, ${BACKUP_DESIGNEE.state} ${BACKUP_DESIGNEE.zip}`;

  const rows = isIndividual ? getSection3Individual(years) : getSection3Business(years);

  const fieldMap: Record<string, string> = {
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
  };

  // Write field data to temp file for Python to read
  const tmpId = randomUUID();
  const jsonPath = path.join(os.tmpdir(), `8821-fields-${tmpId}.json`);
  const outputPath = path.join(os.tmpdir(), `8821-filled-${tmpId}.pdf`);

  await writeFile(jsonPath, JSON.stringify({ templatePath, outputPath, fieldMap }));

  // Run Python script to fill XFA form fields
  const pyScript = `
import fitz, json, sys
data = json.load(open(sys.argv[1]))
doc = fitz.open(data["templatePath"])
page = doc[0]
for widget in page.widgets():
    short = widget.field_name.split(".")[-1].replace("[0]", "")
    if short in data["fieldMap"]:
        widget.field_value = data["fieldMap"][short]
        widget.update()
doc.save(data["outputPath"])
doc.close()
`;

  try {
    await new Promise<void>((resolve, reject) => {
      execFile('python3', ['-c', pyScript, jsonPath], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    const pdfBuffer = await readFile(outputPath);
    return Buffer.from(pdfBuffer);
  } finally {
    // Clean up temp files
    await unlink(jsonPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}
