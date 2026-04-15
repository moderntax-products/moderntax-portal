/**
 * Server-side Compliance Screening for IRS HTML Transcripts
 *
 * Ports the bookmarklet's screenTranscript() (irs-batch-v6.js:296-375)
 * to run in Node.js without DOMParser. Uses regex on HTML/text content.
 *
 * Two main exports:
 *  - screenTranscriptHtml: Extracts financials, transaction codes, compliance flags
 *  - parseTranscriptMetadata: Extracts taxpayer name, TIN, form type, year, transcript type
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComplianceFlag {
  type: string;
  severity: 'CRITICAL' | 'WARNING';
  message: string;
}

export interface ComplianceResult {
  severity: 'CRITICAL' | 'WARNING' | 'CLEAN';
  isBlank: boolean;
  flags: ComplianceFlag[];
  financials: {
    grossReceipts: number | null;
    totalIncome: number | null;
    totalDeductions: number | null;
    totalTax: number | null;
    accountBalance: number | null;
    accruedInterest: number | null;
    accruedPenalty: number | null;
    accountBalancePlusAccruals: number | null;
  };
  transactionCodes: { code: string; explanation: string; date: string; amount: string }[];
}

export interface TranscriptMetadata {
  taxpayerName: string;
  tin: string;
  formType: string;
  taxYear: string;
  transcriptType: 'return_transcript' | 'record_of_account' | 'entity_transcript' | 'wage_income' | 'account_transcript' | 'unknown';
  trackingId: string;
  dateOfIssue: string;
  entityData?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip all HTML tags to get plain text content */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract a dollar amount from text using a regex pattern */
function extractDollar(text: string, regex: RegExp): number | null {
  const m = text.match(regex);
  if (!m) return null;
  return parseFloat(m[1].replace(/,/g, ''));
}

// ---------------------------------------------------------------------------
// Compliance Screening
// ---------------------------------------------------------------------------

/**
 * Screen an IRS HTML transcript for compliance issues.
 *
 * Extracts financial data, transaction codes, and compliance flags.
 * Matches the bookmarklet's screenTranscript() logic exactly.
 */
export function screenTranscriptHtml(htmlString: string): ComplianceResult {
  const fullText = stripHtml(htmlString);

  const result: ComplianceResult = {
    severity: 'CLEAN',
    isBlank: false,
    flags: [],
    financials: {
      grossReceipts: null,
      totalIncome: null,
      totalDeductions: null,
      totalTax: null,
      accountBalance: null,
      accruedInterest: null,
      accruedPenalty: null,
      accountBalancePlusAccruals: null,
    },
    transactionCodes: [],
  };

  // Check for blank/unfiled returns
  if (/No record of return filed/i.test(fullText) || /No transcript available/i.test(fullText)) {
    result.isBlank = true;
    result.severity = 'CRITICAL';
    result.flags.push({ type: 'UNFILED', severity: 'CRITICAL', message: 'No record of return filed' });
    return result;
  }

  // Extract financial fields
  result.financials.grossReceipts = extractDollar(fullText, /GROSS RECEIPTS[^:]*:\s*\$([\d,.]+)/);
  result.financials.totalIncome = extractDollar(fullText, /TOTAL INCOME[^:]*:\s*\$([\d,.]+)/);
  result.financials.totalDeductions = extractDollar(fullText, /TOTAL DEDUCTIONS[^:]*:\s*\$([\d,.]+)/);
  result.financials.totalTax = extractDollar(fullText, /TOTAL TAX[^:]*:\s*\$([\d,.]+)/);
  result.financials.accountBalance = extractDollar(fullText, /ACCOUNT BALANCE:\s*\$([\d,.]+)/);
  result.financials.accruedInterest = extractDollar(fullText, /ACCRUED INTEREST:\s*\$([\d,.]+)/);
  result.financials.accruedPenalty = extractDollar(fullText, /ACCRUED PENALTY:\s*\$([\d,.]+)/);
  result.financials.accountBalancePlusAccruals = extractDollar(fullText, /ACCOUNT BALANCE PLUS ACCRUALS:\s*\$([\d,.]+)/);

  // Extract transaction codes
  const tcRegex = /(\d{3})\s+(.+?)\s+(\d{2}-\d{2}-\d{4})\s+(\$[\d,.]+|-?\$[\d,.]+)?/g;
  let tcMatch;
  while ((tcMatch = tcRegex.exec(fullText)) !== null) {
    const code = parseInt(tcMatch[1]);
    result.transactionCodes.push({
      code: tcMatch[1],
      explanation: tcMatch[2].trim(),
      date: tcMatch[3],
      amount: tcMatch[4] || '',
    });

    // Flag critical transaction codes
    if ([582, 583].includes(code)) {
      result.flags.push({ type: 'LIEN', severity: 'CRITICAL', message: `Federal tax lien (TC ${code}) filed on ${tcMatch[3]}` });
    }
    if (code === 670 && /levy/i.test(tcMatch[2])) {
      result.flags.push({ type: 'LEVY', severity: 'CRITICAL', message: `Levy action on ${tcMatch[3]}` });
    }
    if ([420, 421].includes(code)) {
      result.flags.push({ type: 'AUDIT', severity: 'CRITICAL', message: `Examination initiated (TC ${code}) on ${tcMatch[3]}` });
    }
    if (code === 150 && /substitute/i.test(tcMatch[2])) {
      result.flags.push({ type: 'SFR', severity: 'CRITICAL', message: `IRS filed Substitute for Return on ${tcMatch[3]}` });
    }
    if ([520, 530].includes(code)) {
      result.flags.push({ type: 'COLLECTION', severity: 'CRITICAL', message: `Collection action (TC ${code}) on ${tcMatch[3]}` });
    }
    if (code === 971 && /installment/i.test(tcMatch[2])) {
      result.flags.push({ type: 'INSTALLMENT', severity: 'WARNING', message: `Installment agreement on ${tcMatch[3]}` });
    }
    if ([480, 481].includes(code)) {
      result.flags.push({ type: 'OIC', severity: 'WARNING', message: `Offer in Compromise (TC ${code}) on ${tcMatch[3]}` });
    }
  }

  // Check balance due
  const effectiveBalance = result.financials.accountBalancePlusAccruals ?? result.financials.accountBalance;
  if (effectiveBalance !== null && effectiveBalance > 0) {
    result.flags.push({
      type: 'BALANCE_DUE',
      severity: 'CRITICAL',
      message: `Outstanding balance: $${effectiveBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
    });
  }

  // Determine overall severity
  const severities = result.flags.map((f) => f.severity);
  if (severities.includes('CRITICAL')) result.severity = 'CRITICAL';
  else if (severities.includes('WARNING')) result.severity = 'WARNING';

  return result;
}

// ---------------------------------------------------------------------------
// Metadata Extraction
// ---------------------------------------------------------------------------

/**
 * Parse IRS HTML transcript to extract structured metadata.
 *
 * Handles two HTML formats:
 *  1. Modern IRS TDS: uses .item-container / .item-label / .item-value classes
 *  2. Legacy IRS HTML: uses table/td layout with bold labels
 *
 * Also parses entity transcripts for business data (filing requirements, NAICS, etc).
 */
export function parseTranscriptMetadata(htmlString: string): TranscriptMetadata {
  const fullText = stripHtml(htmlString);

  const meta: TranscriptMetadata = {
    taxpayerName: '',
    tin: '',
    formType: '',
    taxYear: '',
    transcriptType: 'unknown',
    trackingId: '',
    dateOfIssue: '',
  };

  // Detect transcript type from content
  if (/Entity Transcript/i.test(htmlString)) {
    meta.transcriptType = 'entity_transcript';
  } else if (/Return Transcript/i.test(htmlString)) {
    meta.transcriptType = 'return_transcript';
  } else if (/Record of Account/i.test(htmlString)) {
    meta.transcriptType = 'record_of_account';
  } else if (/Account Transcript/i.test(htmlString)) {
    meta.transcriptType = 'account_transcript';
  } else if (/Wage and Income/i.test(htmlString)) {
    meta.transcriptType = 'wage_income';
  }

  // Extract tracking ID: "Tracking ID: 109737692204"
  const trackingMatch = fullText.match(/Tracking ID:\s*([\d]+)/);
  if (trackingMatch) meta.trackingId = trackingMatch[1];

  // Extract date of issue: "Date of Issue: 02-11-2026"
  const dateMatch = fullText.match(/Date of Issue:\s*([\d-]+)/);
  if (dateMatch) meta.dateOfIssue = dateMatch[1];

  // ---- Modern IRS format: item-container divs ----
  // Extract from class="item-label" / class="item-value" pairs
  const itemRegex = /class="item-label"[^>]*>([^<]*)<[\s\S]*?class="item-value"[^>]*>([^<]*)</g;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(htmlString)) !== null) {
    const label = itemMatch[1].trim();
    const value = itemMatch[2].trim();

    if (/Form Number|^Form:/i.test(label)) meta.formType = value;
    if (/Taxpayer Identification/i.test(label)) meta.tin = value;
    if (/Tax Period|Report for Tax Period/i.test(label)) {
      const ym = value.match(/(\d{4})/);
      if (ym) meta.taxYear = ym[1];
    }
  }

  // ---- Legacy IRS format: bold labels in table cells ----
  if (!meta.formType) {
    const formMatch = fullText.match(/Form(?:\s+Number)?[:\s]+(\d{4}[A-Z]?)/i);
    if (formMatch) meta.formType = formMatch[1];
  }
  if (!meta.tin) {
    const tinMatch = fullText.match(/Taxpayer Identification Number[:\s]+([\d-]+)/i);
    if (tinMatch) meta.tin = tinMatch[1];
  }
  if (!meta.taxYear) {
    const yearMatch = fullText.match(/Tax Period[:\s]+.*?(\d{4})/i);
    if (yearMatch) meta.taxYear = yearMatch[1];
  }

  // Extract taxpayer name — appears early in the HTML after the IRS header
  // IRS format: name appears in first table rows after Memphis address
  const namePatterns = [
    // Name in a table cell after "MEMPHIS, TN" block
    /MEMPHIS.*?<\/tr>\s*<\/table>[\s\S]*?<table[^>]*>[\s\S]*?<td[^>]*class="monospace"[^>]*align="left"[^>]*>([^<]+)</i,
    // Name as first cell content in letter address block
    /xmlns:Form\d+[^>]*>\s*<td[^>]*>([^<]+)<\/td>/,
    // Fallback: find name near the top of the transcript
    /<td[^>]*class="monospace"[^>]*align="left"[^>]*>\s*([A-Z][A-Z\s&,.'()-]+?)\s*<\/td>/,
  ];
  for (const pattern of namePatterns) {
    if (meta.taxpayerName) break;
    const nameMatch = htmlString.match(pattern);
    if (nameMatch) {
      const candidate = nameMatch[1].trim();
      // Skip addresses and IRS locations
      if (candidate && !/MEMPHIS|DEPARTMENT|INTERNAL REVENUE/i.test(candidate) && candidate.length < 80) {
        meta.taxpayerName = candidate;
      }
    }
  }

  // Entity transcript special handling
  if (meta.transcriptType === 'entity_transcript') {
    meta.formType = 'BMF_ENTITY';
    const entityData: Record<string, string> = {};

    // Parse entity transcript fields from table cells
    const cellPairs = htmlString.matchAll(/<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi);
    for (const pair of cellPairs) {
      const label = stripHtml(pair[1]).trim();
      const value = stripHtml(pair[2]).trim();

      if (/EIN.*Provided|Employer Identification/i.test(label) && value) {
        if (!meta.tin) meta.tin = value;
      }
      if (/^Primary Name/i.test(label) && value) {
        if (!meta.taxpayerName) meta.taxpayerName = value;
        entityData.primaryName = value;
      }
      if (/^Filing Requirements/i.test(label)) entityData.filingRequirements = value;
      if (/NAICS|Industry Classification/i.test(label)) entityData.naicsCode = value;
      if (/^IRS Establishment/i.test(label)) entityData.establishmentDate = value;
      if (/^Business Operational/i.test(label)) entityData.operationalDate = value;
      if (/^Business Close/i.test(label) && value) entityData.closeDate = value;
      if (/^Street Address/i.test(label)) entityData.address = value;
      if (/^City:/i.test(label)) entityData.city = value;
      if (/^State:/i.test(label)) entityData.state = value;
      if (/^ZIP Code/i.test(label)) entityData.zipCode = value;
      if (/^Fiscal Year Month/i.test(label) && !/Prior/i.test(label)) entityData.fiscalYearMonth = value;
      if (/^Business Operating Division/i.test(label)) entityData.division = value;
      if (/^Name Control/i.test(label)) entityData.nameControl = value;
    }

    // Fallback TIN extraction for entity transcripts
    if (!meta.tin) {
      const einMatch = fullText.match(/EIN\)?.*?:\s*([\d-]+)/i);
      if (einMatch) meta.tin = einMatch[1];
    }

    // Entity transcripts don't have a tax year — use current year
    if (!meta.taxYear) meta.taxYear = new Date().getFullYear().toString();

    if (Object.keys(entityData).length > 0) {
      meta.entityData = entityData;
    }
  }

  return meta;
}

// ---------------------------------------------------------------------------
// Filename parsing (for Dropbox migration)
// ---------------------------------------------------------------------------

export interface FilenameMetadata {
  entityName: string;
  formType: string;
  transcriptType: 'return_transcript' | 'record_of_account' | 'entity_transcript' | 'wage_income' | 'unknown';
  taxYear: string;
}

/**
 * Parse a Centerstone Dropbox transcript filename to extract metadata.
 *
 * Handles patterns like:
 *   "YU LL - 1120S Record of Account - 2023.html"
 *   "Form 1040 Record of Account - Shilu - 2022.html"
 *   "Entity Transcript for Business - YU LL.html"
 *   "109187980058-1-0058.html" (raw IRS tracking IDs — metadata from HTML content)
 *   "HIRE R & PAYA PATE - 1040 Record of Account - 2022.pdf"
 */
export function parseFilename(filename: string): FilenameMetadata | null {
  // Pattern 1: "{NAME} - {FormType} {TranscriptType} - {Year}.{ext}"
  const p1 = filename.match(/^(.+?)\s*-\s*(\w+)\s+(Record of Account|Return Transcript|Account Transcript)\s*-\s*(\d{4})\./i);
  if (p1) {
    const transcriptType = /Record of Account/i.test(p1[3]) ? 'record_of_account'
      : /Account Transcript/i.test(p1[3]) ? 'record_of_account'
      : 'return_transcript';
    return {
      entityName: p1[1].trim(),
      formType: p1[2].toUpperCase().replace('-', ''),
      transcriptType,
      taxYear: p1[4],
    };
  }

  // Pattern 2: "Form {FormType} {TranscriptType} - {Name} - {Year}.{ext}"
  const p2 = filename.match(/^Form\s+(\w+)\s+(Record of Account|Tax Return Transcript|Return Transcript|Wage and Income Transcript)\s*-\s*(.+?)\s*-\s*(\d{4})\./i);
  if (p2) {
    const transcriptType = /Record of Account/i.test(p2[2]) ? 'record_of_account'
      : /Wage and Income/i.test(p2[2]) ? 'wage_income'
      : 'return_transcript';
    return {
      entityName: p2[3].trim(),
      formType: p2[1].toUpperCase().replace('-', ''),
      transcriptType,
      taxYear: p2[4],
    };
  }

  // Pattern 3: "Wage and Income Transcript - {Name} - {Year}.{ext}"
  const p3 = filename.match(/^Wage and Income Transcript\s*-\s*(.+?)\s*-\s*(\d{4})\./i);
  if (p3) {
    return {
      entityName: p3[1].trim(),
      formType: 'W2_INCOME',
      transcriptType: 'wage_income',
      taxYear: p3[2],
    };
  }

  // Pattern 4: "Entity Transcript for {Business|Individual} - {NAME}.{ext}"
  const p4 = filename.match(/^Entity Transcript for (?:Business|Individual)\s*-\s*(.+?)\./i);
  if (p4) {
    return {
      entityName: p4[1].trim(),
      formType: 'BMF_ENTITY',
      transcriptType: 'entity_transcript',
      taxYear: new Date().getFullYear().toString(),
    };
  }

  // Pattern 5: Raw IRS tracking IDs — can't parse filename, need HTML content
  if (/^\d+-\d+-\d+\.html$/i.test(filename)) {
    return null; // Caller should parse from HTML content instead
  }

  // Pattern 6: Signed 8821 PDFs
  if (/8821|consent/i.test(filename)) {
    return null; // Not a transcript — skip
  }

  return null;
}
