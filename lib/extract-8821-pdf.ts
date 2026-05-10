/**
 * Extract signer + CC emails from an uploaded 8821 PDF.
 *
 * Why this exists:
 * Processors upload signed 8821s coming from many channels — Dropbox Sign,
 * DocuSign, manual scans, third-party loan-origination platforms. The signed
 * file is the only place we get the *taxpayer's* email (the lender often
 * doesn't pass it through to the CSV intake). That email is what feeds:
 *   - request_entities.signer_email (used by send-pending-8821s to re-issue
 *     if the signature gets invalidated)
 *   - compliance-drip cron (auto-enrolls flagged entities into the
 *     SBA-compliance / tax-prep marketing sequence)
 *
 * Strategy:
 *   1. Extract all email-shaped substrings from the PDF text.
 *   2. Filter out lender CC domains (statewidecdc.com, teamcenterstone.com,
 *      etc.) and ModernTax internal addresses.
 *   3. If the PDF contains a DocuSign Certificate of Completion, use the
 *      "Signer Events" / "Carbon Copy Events" section structure to
 *      definitively classify each email.
 *   4. Otherwise, prefer the email closest in the text to the signer's name
 *      (when we have one).
 *   5. Fall back to: first surviving non-lender email.
 *
 * Returns { signerEmail, ccEmails, allEmails, source }. Caller decides whether
 * to write to the entity (typically only when entity.signer_email is null).
 */

import pdfParse from 'pdf-parse';

// Lender-side domains we never want to add to taxpayer marketing lists.
// These are SBA CDCs / lenders / loan officers we've seen as 8821 CC recipients.
// Update as new ones surface — this list is intentionally an allow-list inverse
// (we'd rather miss a real signer than spam a lender employee).
const LENDER_CC_DOMAINS = new Set<string>([
  // California Statewide CDC
  'calstatewide.com', 'statewidecdc.com',
  // Centerstone
  'teamcenterstone.com', 'centerstone.com',
  // Common SBA CDC patterns we've seen
  'cdcloans.com', 'sbacdc.com', 'cdcsmallbusiness.org',
  // ModernTax internal
  'moderntax.io', 'moderntax.com',
  // DocuSign / Dropbox Sign system addresses (never real signers)
  'docusign.com', 'docusign.net', 'hellosign.com', 'dropboxsign.com',
]);

// Lender-y substrings — checked against the DOMAIN ONLY (never the local-part).
// This avoids false positives where a borrower's local-part happens to contain
// a banking word (e.g. "mybankaccount@gmail.com", "lending-tree-fan@yahoo.com").
// Defense-in-depth for new CDCs / lenders that haven't made it into the
// explicit LENDER_CC_DOMAINS blocklist yet.
const LENDER_DOMAIN_KEYWORDS = [
  'cdc', 'sba', 'lending', 'lender', 'capital', 'bank',
  'mortgage', 'creditunion',
];

// Personal email providers — STRONG positive signal that an email belongs to
// a borrower / signer. The exact opposite of the lender list. When picking
// between candidates from a 8821 PDF, prefer one of these over a business
// domain we can't classify.
const PERSONAL_EMAIL_DOMAINS = new Set<string>([
  'gmail.com', 'yahoo.com', 'icloud.com', 'me.com', 'mac.com',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'aol.com', 'comcast.net', 'verizon.net', 'sbcglobal.net',
  'att.net', 'bellsouth.net', 'cox.net', 'charter.net',
  'protonmail.com', 'proton.me', 'pm.me',
]);

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// DocuSign Certificate of Completion section markers. Real CoC pages render
// "Signer Events" then per-signer rows with email; "Carbon Copy Events" then
// per-CC rows with email. The marker variants below cover the spacing
// quirks pdf-parse produces.
const COC_SIGNER_MARKERS = [
  'Signer Events',
  'Signer\nEvents',
  'In Person Signer Events',
  'Editor Delivery Events',
];
const COC_CC_MARKERS = [
  'Carbon Copy Events',
  'Carbon Copy\nEvents',
  'CC Events',
];

export interface Extract8821Result {
  signerEmail: string | null;
  ccEmails: string[];
  /** Every email found in the PDF (pre-filter), useful for audit logs. */
  allEmails: string[];
  /** How signerEmail was selected — null if no candidate survived filters. */
  source: 'docusign-coc' | 'personal-email-domain' | 'name-proximity' | 'first-non-lender' | null;
  /** Lender-domain matches we filtered out — surfaced for admin visibility. */
  filteredLenderEmails: string[];
}

export function isLenderEmail(email: string): boolean {
  const lower = email.toLowerCase();
  const domain = lower.split('@')[1] || '';
  if (LENDER_CC_DOMAINS.has(domain)) return true;
  // Personal-email providers are NEVER lenders — short-circuit before the
  // keyword check so a personal email with a "bank"/"loan" local-part
  // doesn't get falsely blocked.
  if (PERSONAL_EMAIL_DOMAINS.has(domain)) return false;
  // Keyword check on the DOMAIN only — borrower emails like
  // "bankaccount@gmail.com" or "lendingclubfan@yahoo.com" are kept because
  // gmail.com / yahoo.com don't contain any keyword.
  return LENDER_DOMAIN_KEYWORDS.some(kw => domain.includes(kw));
}

export function isPersonalEmail(email: string): boolean {
  const domain = email.toLowerCase().split('@')[1] || '';
  return PERSONAL_EMAIL_DOMAINS.has(domain);
}

/**
 * Slice the PDF text between two markers. Returns null if start marker not
 * found. End marker is optional — null end = read to end of document.
 */
function sliceBetween(text: string, startMarkers: string[], endMarkers: string[] | null): string | null {
  let startIdx = -1;
  for (const m of startMarkers) {
    const i = text.indexOf(m);
    if (i >= 0) { startIdx = i + m.length; break; }
  }
  if (startIdx < 0) return null;
  if (!endMarkers) return text.slice(startIdx);
  let endIdx = text.length;
  for (const m of endMarkers) {
    const i = text.indexOf(m, startIdx);
    if (i >= 0 && i < endIdx) endIdx = i;
  }
  return text.slice(startIdx, endIdx);
}

/**
 * When the PDF contains a DocuSign Certificate of Completion, classify
 * each email by which section it appears in. Returns null if no CoC found.
 */
function classifyByDocusignCoc(text: string): { signerEmail: string | null; ccEmails: string[] } | null {
  const signerSection = sliceBetween(text, COC_SIGNER_MARKERS, [...COC_CC_MARKERS, 'Witness Events', 'Notary Events', 'Envelope Summary']);
  const ccSection = sliceBetween(text, COC_CC_MARKERS, ['Witness Events', 'Notary Events', 'Envelope Summary']);

  if (!signerSection && !ccSection) return null;

  const signerEmails = signerSection ? Array.from(new Set(signerSection.match(EMAIL_REGEX) || [])) : [];
  const ccEmails = ccSection ? Array.from(new Set(ccSection.match(EMAIL_REGEX) || [])) : [];

  // Pick the first signer email that isn't lender-flagged. The CoC may list
  // a lender employee as a signer in rare cases (e.g. lender "Sender" event
  // metadata) — we still skip those.
  const signerEmail = signerEmails.find(e => !isLenderEmail(e)) || null;

  // CCs: keep all — they're useful for audit. Caller will filter lender ones
  // before any marketing use.
  return { signerEmail, ccEmails };
}

/**
 * Pick the email whose position in the text is closest to the signer's name.
 * Used when there's no DocuSign CoC structure (e.g. flattened PDFs, manual scans).
 */
function pickByNameProximity(text: string, candidates: string[], signerName: string | null): string | null {
  if (!signerName || candidates.length === 0) return null;
  const nameIdx = text.toLowerCase().indexOf(signerName.toLowerCase());
  if (nameIdx < 0) return null;

  let best: { email: string; distance: number } | null = null;
  for (const email of candidates) {
    const idx = text.indexOf(email);
    if (idx < 0) continue;
    const distance = Math.abs(idx - nameIdx);
    if (!best || distance < best.distance) {
      best = { email, distance };
    }
  }
  return best?.email || null;
}

/**
 * Main extraction entry point. Buffer in, structured result out.
 *
 * @param pdfBuffer — the uploaded 8821 PDF
 * @param signerName — optional, used as a tiebreaker. Pass entity.signer_first_name + ' ' + entity.signer_last_name when available.
 */
export async function extractEmailsFrom8821(
  pdfBuffer: Buffer,
  signerName: string | null = null
): Promise<Extract8821Result> {
  let text = '';
  try {
    const data = await pdfParse(pdfBuffer);
    text = data.text || '';
  } catch (err) {
    // Encrypted or malformed PDF — return empty result rather than throwing.
    // The upload itself still succeeds; we just can't help with the email.
    console.error('[extract-8821-pdf] pdf-parse failed:', err);
    return {
      signerEmail: null,
      ccEmails: [],
      allEmails: [],
      source: null,
      filteredLenderEmails: [],
    };
  }

  const allEmailsRaw = Array.from(new Set((text.match(EMAIL_REGEX) || []).map(e => e.toLowerCase())));

  // Bucket lender emails out for visibility (we'll surface them in the audit log
  // even though we won't use them for marketing).
  const filteredLenderEmails = allEmailsRaw.filter(isLenderEmail);
  const candidateEmails = allEmailsRaw.filter(e => !isLenderEmail(e));

  // 1. Try DocuSign Certificate of Completion structure first — most reliable.
  const cocResult = classifyByDocusignCoc(text);
  if (cocResult && cocResult.signerEmail) {
    return {
      signerEmail: cocResult.signerEmail,
      ccEmails: cocResult.ccEmails.filter(e => !isLenderEmail(e)),
      allEmails: allEmailsRaw,
      source: 'docusign-coc',
      filteredLenderEmails,
    };
  }

  // 2. Strong positive signal: a candidate on a personal-email domain
  //    (gmail/yahoo/icloud/outlook/hotmail/etc.). Borrowers almost always
  //    sign with a personal address — when one is present and survived the
  //    lender filter, it's overwhelmingly likely to be the merchant. Prefer
  //    the one closest to the signer's name in the text if we have one,
  //    else just the first.
  const personalCandidates = candidateEmails.filter(isPersonalEmail);
  if (personalCandidates.length > 0) {
    const pick =
      pickByNameProximity(text, personalCandidates, signerName) ||
      personalCandidates[0];
    return {
      signerEmail: pick,
      ccEmails: candidateEmails.filter(e => e !== pick),
      allEmails: allEmailsRaw,
      source: 'personal-email-domain',
      filteredLenderEmails,
    };
  }

  // 3. Fall back to name proximity if signer name is known (business-domain signer).
  const proximityHit = pickByNameProximity(text, candidateEmails, signerName);
  if (proximityHit) {
    return {
      signerEmail: proximityHit,
      ccEmails: candidateEmails.filter(e => e !== proximityHit),
      allEmails: allEmailsRaw,
      source: 'name-proximity',
      filteredLenderEmails,
    };
  }

  // 4. Last resort: first non-lender email. Often correct for simple manual scans.
  if (candidateEmails.length > 0) {
    return {
      signerEmail: candidateEmails[0],
      ccEmails: candidateEmails.slice(1),
      allEmails: allEmailsRaw,
      source: 'first-non-lender',
      filteredLenderEmails,
    };
  }

  // No usable email found.
  return {
    signerEmail: null,
    ccEmails: [],
    allEmails: allEmailsRaw,
    source: null,
    filteredLenderEmails,
  };
}
