/**
 * IRS Wage & Income Transcript Parser
 *
 * Parses raw text extracted from IRS Wage & Income transcript PDFs
 * into structured JSON matching the EmploymentData type, plus
 * comprehensive income_sources for all form types.
 */

import type { EmploymentData, EmploymentEmployer, EmploymentYearData } from './types';

// ---------------------------------------------------------------------------
// Public return types
// ---------------------------------------------------------------------------

export interface IncomeSource {
  form_type: string;
  payer_ein: string;
  payer_name: string;
  payer_address: string;
  recipient_name: string;
  recipient_tin_last_four: string;
  tax_year: string;
  fields: Record<string, string | number>;
}

export interface TranscriptMetadata {
  tin_provided: string;
  ssn_last_four: string;
  tax_period: string;
  tax_year: string;
  request_date: string;
  response_date: string;
  tracking_number: string;
}

export interface ParsedTranscript {
  metadata: TranscriptMetadata;
  employment_data: EmploymentData;
  income_sources: IncomeSource[];
  raw_sections: RawFormSection[];
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RawFormSection {
  form_type: string;
  form_title: string;
  payer_ein: string;
  payer_name: string;
  payer_address: string;
  recipient_tin: string;
  recipient_name: string;
  recipient_address: string;
  fields: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

// Matches metadata lines
const TIN_RE = /TIN\s+Provided[:\s]+(\S+)/i;
const TAX_PERIOD_RE = /Tax\s+Period\s+Requested[:\s]+([\d-]+)/i;
const REQUEST_DATE_RE = /Request\s+Date[:\s]+([\d\/\-]+)/i;
const RESPONSE_DATE_RE = /Response\s+Date[:\s]+([\d\/\-]+)/i;
const TRACKING_RE = /Tracking\s+Number[:\s]+(\S+)/i;

// Matches payer/employer blocks
const FIN_RE = /(?:FIN|EIN|Federal\s+Identification\s+Number)[:\s]*(\d{2}[\s-]?\d{7})/i;
// Field-value pattern: "Field Name ..... Value" or "Field Name: Value"
const FIELD_VALUE_RE = /^(.+?)[\s.]{2,}([\d,.$\-()]+)\s*$/;
const FIELD_COLON_RE = /^(.+?):\s+([\d,.$\-()]+)\s*$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanAmount(raw: string): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[$,]/g, '').replace(/\((.+)\)/, '-$1').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function extractLast4(tin: string): string {
  const digits = tin.replace(/\D/g, '');
  return digits.slice(-4);
}

function extractYear(taxPeriod: string): string {
  // Tax period is typically "12-31-2023" or "12/31/2023" or just "2023"
  const match = taxPeriod.match(/(\d{4})/);
  return match ? match[1] : '';
}

function normalizeFormType(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, ' ');
}

function normalizeEin(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 9) {
    return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  }
  return raw.trim();
}

// ---------------------------------------------------------------------------
// Metadata extraction
// ---------------------------------------------------------------------------

function parseMetadata(text: string): TranscriptMetadata {
  const tinMatch = text.match(TIN_RE);
  const tin = tinMatch ? tinMatch[1].trim() : '';

  const periodMatch = text.match(TAX_PERIOD_RE);
  const taxPeriod = periodMatch ? periodMatch[1].trim() : '';

  const reqDateMatch = text.match(REQUEST_DATE_RE);
  const reqDate = reqDateMatch ? reqDateMatch[1].trim() : '';

  const resDateMatch = text.match(RESPONSE_DATE_RE);
  const resDate = resDateMatch ? resDateMatch[1].trim() : '';

  const trackingMatch = text.match(TRACKING_RE);
  const tracking = trackingMatch ? trackingMatch[1].trim() : '';

  return {
    tin_provided: tin,
    ssn_last_four: extractLast4(tin),
    tax_period: taxPeriod,
    tax_year: extractYear(taxPeriod),
    request_date: reqDate,
    response_date: resDate,
    tracking_number: tracking,
  };
}

// ---------------------------------------------------------------------------
// Section splitting
// ---------------------------------------------------------------------------

/**
 * Split the transcript text into individual form sections.
 * Each section starts with a "Form ..." header line.
 */
function splitSections(text: string): { formType: string; formTitle: string; body: string }[] {
  const lines = text.split(/\r?\n/);
  const sections: { formType: string; formTitle: string; body: string }[] = [];
  let currentFormType = '';
  let currentTitle = '';
  let bodyLines: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(
      /^\s*Form\s+(W-2G?|1099-(?:NEC|MISC|B|G|INT|DIV|R|K|SA|S)|5498-SA|1098)\b(.*)/i
    );
    if (headerMatch) {
      // Save previous section
      if (currentFormType) {
        sections.push({
          formType: normalizeFormType(currentFormType),
          formTitle: currentTitle,
          body: bodyLines.join('\n'),
        });
      }
      currentFormType = headerMatch[1];
      currentTitle = line.trim();
      bodyLines = [];
    } else {
      bodyLines.push(line);
    }
  }

  // Don't forget the last section
  if (currentFormType) {
    sections.push({
      formType: normalizeFormType(currentFormType),
      formTitle: currentTitle,
      body: bodyLines.join('\n'),
    });
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Section parsing
// ---------------------------------------------------------------------------

function extractEntityBlock(
  text: string,
  label: string
): { ein: string; name: string; address: string } {
  const result = { ein: '', name: '', address: '' };

  // Look for a labeled block: "Payer:" / "Employer:" / "Recipient:" etc.
  // The block may span several lines after the label
  const blockRe = new RegExp(
    `(?:${label})\\s*(?:Name and Address|Information)?[:\\s]*\\n([\\s\\S]*?)(?=\\n\\s*(?:Recipient|Employee|Payer|Employer|$))`,
    'i'
  );
  const blockMatch = text.match(blockRe);

  // Also try to find EIN/FIN anywhere in this section
  const einMatch = text.match(FIN_RE);
  if (einMatch) {
    result.ein = normalizeEin(einMatch[1]);
  }

  if (blockMatch) {
    const blockLines = blockMatch[1]
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // First non-empty line is usually the name
    if (blockLines.length > 0) {
      // Check if first line is an EIN
      const firstEin = blockLines[0].match(/^(\d{2}[\s-]?\d{7})$/);
      if (firstEin) {
        result.ein = normalizeEin(firstEin[1]);
        blockLines.shift();
      }
    }
    if (blockLines.length > 0) {
      result.name = blockLines[0];
    }
    if (blockLines.length > 1) {
      result.address = blockLines.slice(1).join(', ');
    }
  } else {
    // Fallback: try line-by-line matching
    const nameMatch = text.match(
      new RegExp(`${label}\\s*(?:Name)?[:\\s]+(.+)`, 'i')
    );
    if (nameMatch) {
      result.name = nameMatch[1].trim();
    }
  }

  return result;
}

function extractPayerBlock(text: string): { ein: string; name: string; address: string } {
  // Try "Payer" first, then "Employer"
  let result = extractEntityBlock(text, 'Payer');
  if (!result.name) {
    result = extractEntityBlock(text, 'Employer');
  }

  // If we still don't have an EIN, try the general FIN pattern
  if (!result.ein) {
    const einMatch = text.match(FIN_RE);
    if (einMatch) {
      result.ein = normalizeEin(einMatch[1]);
    }
  }

  return result;
}

function extractRecipientBlock(text: string): { tin: string; name: string; address: string } {
  const block = extractEntityBlock(text, 'Recipient|Employee');

  // Also try "Identification Number" for recipient TIN
  const tinMatch = text.match(
    /(?:Recipient|Employee)\s*(?:Identification\s+Number|TIN|SSN)[:\s]+(\S+)/i
  );
  const tin = tinMatch ? tinMatch[1].trim() : '';

  return {
    tin: tin || block.ein, // recipient's TIN might be captured in the EIN field
    name: block.name,
    address: block.address,
  };
}

function extractFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip header/label lines
    if (/^(Payer|Employer|Recipient|Employee|Form\s)/i.test(trimmed)) continue;
    if (/^(FIN|EIN|Federal\s)/i.test(trimmed)) continue;

    // Try dot-separated pattern first
    let match = trimmed.match(FIELD_VALUE_RE);
    if (match) {
      const fieldName = match[1].replace(/[.\s]+$/, '').trim();
      if (fieldName.length > 2) {
        fields[fieldName] = match[2].trim();
      }
      continue;
    }

    // Try colon-separated pattern
    match = trimmed.match(FIELD_COLON_RE);
    if (match) {
      const fieldName = match[1].replace(/[.\s]+$/, '').trim();
      if (fieldName.length > 2) {
        fields[fieldName] = match[2].trim();
      }
    }
  }

  return fields;
}

function parseSection(
  section: { formType: string; formTitle: string; body: string },
  metadata: TranscriptMetadata
): RawFormSection {
  const payer = extractPayerBlock(section.body);
  const recipient = extractRecipientBlock(section.body);
  const fields = extractFields(section.body);

  return {
    form_type: section.formType,
    form_title: section.formTitle,
    payer_ein: payer.ein,
    payer_name: payer.name,
    payer_address: payer.address,
    recipient_tin: recipient.tin || metadata.tin_provided,
    recipient_name: recipient.name,
    recipient_address: recipient.address,
    fields,
  };
}

// ---------------------------------------------------------------------------
// Income amount extraction per form type
// ---------------------------------------------------------------------------

function getW2Income(fields: Record<string, string>): number {
  // Try common W-2 field names for wages
  const wageKeys = [
    'Wages, tips, other compensation',
    'Wages tips other compensation',
    'Wages, Tips and Other Compensation',
    'Wages',
    'Wage',
    'Wages and tips',
  ];

  for (const key of wageKeys) {
    const match = findFieldCaseInsensitive(fields, key);
    if (match !== null) return cleanAmount(match);
  }

  // Fallback: look for any field containing "wages" or "compensation"
  for (const [k, v] of Object.entries(fields)) {
    if (/wages|compensation/i.test(k)) {
      return cleanAmount(v);
    }
  }

  return 0;
}

function get1099Income(fields: Record<string, string>, formType: string): number {
  switch (formType) {
    case '1099-NEC': {
      const v = findFieldCaseInsensitive(fields, 'Nonemployee compensation');
      return v !== null ? cleanAmount(v) : sumAllAmounts(fields);
    }
    case '1099-MISC': {
      // Box 7 (non-employee comp) or total
      const v =
        findFieldCaseInsensitive(fields, 'Nonemployee compensation') ??
        findFieldCaseInsensitive(fields, 'Rents') ??
        findFieldCaseInsensitive(fields, 'Other income');
      return v !== null ? cleanAmount(v) : sumAllAmounts(fields);
    }
    case '1099-B': {
      const v = findFieldCaseInsensitive(fields, 'Proceeds');
      return v !== null ? cleanAmount(v) : sumAllAmounts(fields);
    }
    case '1099-INT': {
      const v = findFieldCaseInsensitive(fields, 'Interest income');
      return v !== null ? cleanAmount(v) : sumAllAmounts(fields);
    }
    case '1099-DIV': {
      const v =
        findFieldCaseInsensitive(fields, 'Total ordinary dividends') ??
        findFieldCaseInsensitive(fields, 'Ordinary dividends');
      return v !== null ? cleanAmount(v) : sumAllAmounts(fields);
    }
    case '1099-R': {
      const v =
        findFieldCaseInsensitive(fields, 'Gross distribution') ??
        findFieldCaseInsensitive(fields, 'Gross Distribution');
      return v !== null ? cleanAmount(v) : sumAllAmounts(fields);
    }
    case '1099-G': {
      const v =
        findFieldCaseInsensitive(fields, 'Unemployment compensation') ??
        findFieldCaseInsensitive(fields, 'State or local income tax refunds');
      return v !== null ? cleanAmount(v) : sumAllAmounts(fields);
    }
    case '1099-K': {
      const v = findFieldCaseInsensitive(fields, 'Gross amount of payment card');
      return v !== null ? cleanAmount(v) : sumAllAmounts(fields);
    }
    case '5498-SA': {
      const v = findFieldCaseInsensitive(fields, 'Employee contributions');
      return v !== null ? cleanAmount(v) : sumAllAmounts(fields);
    }
    default:
      return sumAllAmounts(fields);
  }
}

function findFieldCaseInsensitive(
  fields: Record<string, string>,
  search: string
): string | null {
  const lower = search.toLowerCase();
  for (const [k, v] of Object.entries(fields)) {
    if (k.toLowerCase().includes(lower)) return v;
  }
  return null;
}

function sumAllAmounts(fields: Record<string, string>): number {
  let total = 0;
  for (const v of Object.values(fields)) {
    const amt = cleanAmount(v);
    if (amt > 0) total += amt;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Build EmploymentData from parsed sections
// ---------------------------------------------------------------------------

function buildIncomeSource(
  section: RawFormSection,
  metadata: TranscriptMetadata
): IncomeSource {
  const numericFields: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(section.fields)) {
    const num = cleanAmount(v);
    numericFields[k] = num !== 0 ? num : v;
  }

  return {
    form_type: section.form_type,
    payer_ein: section.payer_ein,
    payer_name: section.payer_name,
    payer_address: section.payer_address,
    recipient_name: section.recipient_name || metadata.tin_provided,
    recipient_tin_last_four: extractLast4(section.recipient_tin || metadata.tin_provided),
    tax_year: metadata.tax_year,
    fields: numericFields,
  };
}

function buildEmploymentData(
  sections: RawFormSection[],
  metadata: TranscriptMetadata,
  requestId: string
): EmploymentData {
  const year = metadata.tax_year;
  const w2Sections = sections.filter((s) => s.form_type === 'W-2');
  const allSections = sections;

  // Build employers from W-2 sections
  const employers: EmploymentEmployer[] = w2Sections.map((s) => ({
    ein: s.payer_ein,
    name: s.payer_name,
    address: s.payer_address,
    gross_earnings: getW2Income(s.fields),
    form_type: 'W-2',
    is_peo: false,
  }));

  const totalW2 = employers.reduce((sum, e) => sum + e.gross_earnings, 0);

  // Total income across all form types
  let totalIncome = totalW2;
  for (const s of allSections) {
    if (s.form_type !== 'W-2') {
      totalIncome += get1099Income(s.fields, s.form_type);
    }
  }

  // Determine recipient name from first section with one
  const recipientName =
    sections.find((s) => s.recipient_name)?.recipient_name || '';

  const yearData: EmploymentYearData = {
    total_w2_income: totalW2,
    total_income: totalIncome,
    employers,
  };

  const employmentByYear: Record<string, EmploymentYearData> = {};
  if (year) {
    employmentByYear[year] = yearData;
  }

  return {
    request_id: requestId,
    status: 'completed',
    timestamp: new Date().toISOString(),
    taxpayer: {
      ssn_last_four: metadata.ssn_last_four,
      name: recipientName,
    },
    employment_by_year: employmentByYear,
    summary: {
      total_employers: employers.length,
      total_w2_income: totalW2,
      total_income: totalIncome,
      years_covered: year ? [parseInt(year, 10)] : [],
    },
    completed_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse raw text from an IRS Wage & Income transcript into structured data.
 *
 * @param text - Raw text extracted from the transcript PDF
 * @param requestId - The ModernTax request ID to embed in the output
 * @returns Parsed transcript with EmploymentData and comprehensive income sources
 */
export function parseWageIncomeTranscript(
  text: string,
  requestId: string = ''
): ParsedTranscript {
  if (!text || typeof text !== 'string') {
    throw new Error('Transcript text is required');
  }

  // 1. Extract document metadata
  const metadata = parseMetadata(text);

  // 2. Split into form sections
  const rawSections = splitSections(text);

  // 3. Parse each section
  const parsedSections = rawSections.map((s) => parseSection(s, metadata));

  // 4. Build income sources (all form types)
  const incomeSources = parsedSections.map((s) =>
    buildIncomeSource(s, metadata)
  );

  // 5. Build EmploymentData (focused on W-2s)
  const employmentData = buildEmploymentData(
    parsedSections,
    metadata,
    requestId
  );

  return {
    metadata,
    employment_data: employmentData,
    income_sources: incomeSources,
    raw_sections: parsedSections,
  };
}

/**
 * Parse multiple transcript texts (e.g., one per tax year) and merge results.
 *
 * @param texts - Array of { text, year? } objects
 * @param requestId - The ModernTax request ID
 * @returns Merged ParsedTranscript with data from all years
 */
export function parseMultipleTranscripts(
  texts: { text: string; year?: string }[],
  requestId: string = ''
): ParsedTranscript {
  if (texts.length === 0) {
    throw new Error('At least one transcript text is required');
  }

  if (texts.length === 1) {
    return parseWageIncomeTranscript(texts[0].text, requestId);
  }

  // Parse each transcript individually
  const results = texts.map((t) => parseWageIncomeTranscript(t.text, requestId));

  // Merge: use first transcript's metadata as the base
  const merged: ParsedTranscript = {
    metadata: results[0].metadata,
    employment_data: results[0].employment_data,
    income_sources: [],
    raw_sections: [],
  };

  // Merge employment_by_year, income_sources, and raw_sections
  const allEmployers: EmploymentEmployer[] = [];
  let totalW2 = 0;
  let totalIncome = 0;
  const yearsCovered: number[] = [];

  for (const result of results) {
    merged.income_sources.push(...result.income_sources);
    merged.raw_sections.push(...result.raw_sections);

    for (const [year, yearData] of Object.entries(result.employment_data.employment_by_year)) {
      merged.employment_data.employment_by_year[year] = yearData;
      allEmployers.push(...yearData.employers);
      totalW2 += yearData.total_w2_income || 0;
      totalIncome += yearData.total_income || 0;
      const yearNum = parseInt(year, 10);
      if (!isNaN(yearNum) && !yearsCovered.includes(yearNum)) {
        yearsCovered.push(yearNum);
      }
    }
  }

  // Update summary
  merged.employment_data.summary = {
    total_employers: allEmployers.length,
    total_w2_income: totalW2,
    total_income: totalIncome,
    years_covered: yearsCovered.sort(),
  };

  // Use the most complete taxpayer info
  for (const result of results) {
    if (result.employment_data.taxpayer.name && !merged.employment_data.taxpayer.name) {
      merged.employment_data.taxpayer.name = result.employment_data.taxpayer.name;
    }
    if (result.employment_data.taxpayer.ssn_last_four && !merged.employment_data.taxpayer.ssn_last_four) {
      merged.employment_data.taxpayer.ssn_last_four = result.employment_data.taxpayer.ssn_last_four;
    }
  }

  return merged;
}
