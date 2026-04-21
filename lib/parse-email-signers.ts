/**
 * Parse signer contact info out of an email body.
 *
 * Processors at Centerstone (and other clients) typically paste a list of
 * entities + the signing principal's email into the email body rather than
 * into the attached CSV. The email-intake admin route has historically
 * dropped this data — the CSV template has no `email` column, and the body
 * text is stored in `requests.notes` but never parsed. That left entities
 * without a signer and the auto-8821-send silently skipped them.
 *
 * This module extracts:
 *   • Person name + email pairs ("Natvarlal Patel - rinabpatel@yahoo.com")
 *   • Stand-alone email addresses (as a last-resort fallback)
 *
 * from free-form email body text. It is intentionally lenient — any email
 * we find, attached to the most likely signer name, is better than the
 * previous behaviour of attaching none.
 */

export interface ParsedSigner {
  email: string;
  firstName: string | null;
  lastName: string | null;
  /** Raw line the match came from, for audit trail */
  sourceLine: string;
}

const EMAIL_RE = /\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi;

/**
 * Parse a body of email text looking for "<Name> - <email>" / "<Name> <email>"
 * / "<Name>, email: <email>" / "<Name> (<email>)" style patterns.
 *
 * Returns the list in the order they appear. If no name can be associated
 * with a found email, `firstName`/`lastName` are null but the email is still
 * returned so the caller can decide whether to use it as a fallback signer.
 */
export function parseSignersFromEmailBody(body: string | null | undefined): ParsedSigner[] {
  if (!body) return [];
  const out: ParsedSigner[] = [];
  const seenEmails = new Set<string>();

  // Split into lines for nearby-name heuristics
  const lines = body.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Reset EMAIL_RE state
    EMAIL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = EMAIL_RE.exec(line)) !== null) {
      const email = match[1].toLowerCase();
      if (seenEmails.has(email)) continue;

      // Heuristic: look at the prefix before the email for a name
      const prefix = line.slice(0, match.index).trim();
      // Strip common separators the body might use between name and email
      const nameCandidate = prefix
        .replace(/[-–—:,()]+\s*$/, '')   // trailing separators
        .replace(/^\s*(email|contact|signer)\s*[:\-]?\s*/i, '') // "email:" style prefix
        .replace(/[()]/g, '')
        .trim();

      const { first, last } = splitName(nameCandidate);

      out.push({ email, firstName: first, lastName: last, sourceLine: line });
      seenEmails.add(email);
    }
  }

  return out;
}

/**
 * Split a free-form "First [Middle] Last" string into first/last name parts.
 * Returns nulls if the input doesn't look like a person name.
 */
function splitName(raw: string): { first: string | null; last: string | null } {
  if (!raw) return { first: null, last: null };

  // Reject things that look like sentences rather than names
  if (raw.length > 60) return { first: null, last: null };
  if (/[.!?]$/.test(raw)) return { first: null, last: null };
  // Reject if it includes too many words (more than 5) — probably a sentence
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return { first: null, last: null };
  // Reject if no words are capitalized (probably not a name)
  const capitalized = words.filter(w => /^[A-Z]/.test(w));
  if (capitalized.length === 0) return { first: null, last: null };

  if (words.length === 1) return { first: words[0], last: null };
  return { first: words[0], last: words[words.length - 1] };
}

/**
 * Pick the "most likely principal signer" from a list of parsed signers.
 * When an email lists one individual and several business entities, the
 * principal is usually the individual — so prefer a signer whose name is
 * non-null. Fallback: first email found.
 */
export function pickPrincipalSigner(signers: ParsedSigner[]): ParsedSigner | null {
  if (signers.length === 0) return null;
  const named = signers.find(s => s.firstName && s.lastName);
  return named || signers[0];
}
