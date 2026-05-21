/**
 * Claude vision-based extractor for Form 8821 PDFs from any source.
 *
 * Why this exists:
 * Managers like Derek Le (Enterprise Bank, 2026-05-20) frequently arrive with
 * an 8821 already signed by their borrower but designating a different vendor
 * (Tax Guard, Wolters Kluwer, Avantax, etc.). To pull transcripts via
 * ModernTax we need a fresh 8821 designating us — but transcribing the
 * borrower's info (name, EIN, address, signer, year range) by hand from a
 * scanned/signed PDF is exactly the kind of toil this product should eat.
 *
 * Why AcroForm + pdf-parse aren't enough:
 * - AcroForm fields: most signed 8821s are flattened or scanned (no fields)
 * - pdf-parse: only reads text-layer content; signed Adobe Fill-and-Sign /
 *   scanned PDFs render Section 1 as an image, leaving nothing to extract
 *
 * Strategy:
 * - Send the PDF as a `document` content block to Claude (Sonnet 4.5)
 * - Prompt for structured JSON of every Section 1 + Section 3 field plus
 *   the existing designees so we can warn if ModernTax is already listed
 * - Validate + normalize the response shape; missing fields stay null
 * - Caller falls back to manual entry if ANTHROPIC_API_KEY isn't set
 *
 * Cost: ~$0.01-0.03 per extraction on a 1-2 page PDF. Acceptable.
 */

const MODEL = 'claude-sonnet-4-5';

export interface ExistingDesignee {
  name: string | null;
  caf: string | null;
}

export interface ExtractedTaxpayer {
  taxpayer_name: string | null;
  street_address: string | null;
  city: string | null;
  state: string | null;          // 2-letter code
  zip_code: string | null;
  tin: string | null;            // formatted with dash if EIN
  tin_kind: 'EIN' | 'SSN' | null;
  taxpayer_phone: string | null;
  signer_name: string | null;    // print name from Section 6
  signer_title: string | null;   // e.g. "Member", "President"
  signer_email: string | null;   // rarely on the form itself; extract from any text layer
  signed_date: string | null;    // ISO-ish "YYYY-MM-DD" if extractable
  existing_designees: ExistingDesignee[]; // every Section 2 designee
  form_types_authorized: string | null;   // e.g. "1065/1120/1120S/990/1041/Business Entity Information"
  years_authorized: string | null;        // e.g. "2016 through 2029" or "2022-2026"
  notes: string | null;          // anything the model thinks the human should know
  source: 'vision' | 'fallback'; // 'fallback' = API key missing or call failed
  warnings: string[];
}

const SYSTEM_PROMPT = `You are extracting structured data from a US IRS Form 8821 (Tax Information Authorization).

You will be shown a PDF that may have one or more pages. Find and extract:

SECTION 1 — Taxpayer Information:
  - taxpayer_name: legal entity or individual name as written
  - street_address: street line only (no city/state/zip)
  - city, state (2-letter), zip_code
  - tin: the Taxpayer Identification Number; format as XX-XXXXXXX for EINs (9 digits with dash after 2) or XXX-XX-XXXX for SSNs
  - tin_kind: "EIN" for business taxpayers, "SSN" for individuals
  - taxpayer_phone: as written (keep punctuation)

SECTION 2 — Designees (there can be 2 on the main form plus more on an attachment):
  - existing_designees: array of every designee with their CAF number. CAF appears as "0000-00000R" or similar. Include the attachment page if present.

SECTION 3 — Tax Information:
  - form_types_authorized: the form types listed (e.g. "941/943/944/945" or "1065/1120/1120S/990/1041")
  - years_authorized: the year range or list (e.g. "2016 through 2029")

SECTION 6 — Signature:
  - signer_name: the printed name of the person who signed
  - signer_title: e.g. "Member", "President", "Officer"
  - signed_date: ISO date if extractable; null otherwise

ANYWHERE in the document:
  - signer_email: if any email address appears that isn't a vendor CC, capture it

If a field is not present, blank, illegible, or you're not sure, return null. Do NOT guess or hallucinate.

Return ONLY a single JSON object — no prose, no markdown fences. The schema:
{
  "taxpayer_name": string|null,
  "street_address": string|null,
  "city": string|null,
  "state": string|null,
  "zip_code": string|null,
  "tin": string|null,
  "tin_kind": "EIN"|"SSN"|null,
  "taxpayer_phone": string|null,
  "signer_name": string|null,
  "signer_title": string|null,
  "signer_email": string|null,
  "signed_date": string|null,
  "existing_designees": [{ "name": string|null, "caf": string|null }],
  "form_types_authorized": string|null,
  "years_authorized": string|null,
  "notes": string|null
}`;

export async function extract8821WithVision(pdfBuffer: Buffer | Uint8Array): Promise<ExtractedTaxpayer> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const empty = (source: 'vision' | 'fallback', warnings: string[] = []): ExtractedTaxpayer => ({
    taxpayer_name: null, street_address: null, city: null, state: null, zip_code: null,
    tin: null, tin_kind: null, taxpayer_phone: null,
    signer_name: null, signer_title: null, signer_email: null, signed_date: null,
    existing_designees: [], form_types_authorized: null, years_authorized: null, notes: null,
    source, warnings,
  });

  if (!apiKey) {
    return empty('fallback', ['ANTHROPIC_API_KEY not configured — preview only. Type the fields in manually.']);
  }

  const base64 = Buffer.from(pdfBuffer).toString('base64');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Document content blocks require the betas header before they fully GA'd:
        'anthropic-beta': 'pdfs-2024-09-25',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 },
            },
            {
              type: 'text',
              text: 'Extract the structured data from this Form 8821 and return JSON per the schema.',
            },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[extract-8821-vision] Anthropic API error:', res.status, text.slice(0, 400));
      return empty('fallback', [`Vision extraction failed: HTTP ${res.status}. Type the fields in manually.`]);
    }

    const data: any = await res.json();
    const raw = data?.content?.[0]?.text || '';
    if (!raw) {
      console.error('[extract-8821-vision] Empty response from Claude');
      return empty('fallback', ['Vision extraction returned no content. Type the fields in manually.']);
    }

    // Claude usually returns clean JSON. Be defensive: strip markdown fences if present.
    const cleaned = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('[extract-8821-vision] Could not parse JSON. First 200 chars:', raw.slice(0, 200));
      return empty('fallback', ['Vision response was not valid JSON. Type the fields in manually.']);
    }

    // Coerce + validate the shape — keep nulls for anything missing.
    const norm: ExtractedTaxpayer = {
      ...empty('vision'),
      taxpayer_name: parsed.taxpayer_name || null,
      street_address: parsed.street_address || null,
      city: parsed.city || null,
      state: parsed.state ? String(parsed.state).toUpperCase().slice(0, 2) : null,
      zip_code: parsed.zip_code || null,
      tin: parsed.tin || null,
      tin_kind: parsed.tin_kind === 'SSN' ? 'SSN' : parsed.tin_kind === 'EIN' ? 'EIN' : null,
      taxpayer_phone: parsed.taxpayer_phone || null,
      signer_name: parsed.signer_name || null,
      signer_title: parsed.signer_title || null,
      signer_email: parsed.signer_email || null,
      signed_date: parsed.signed_date || null,
      existing_designees: Array.isArray(parsed.existing_designees)
        ? parsed.existing_designees.map((d: any) => ({
            name: d?.name || null,
            caf: d?.caf || null,
          }))
        : [],
      form_types_authorized: parsed.form_types_authorized || null,
      years_authorized: parsed.years_authorized || null,
      notes: parsed.notes || null,
    };

    // Warn if ModernTax is already designated (no need to convert)
    const moderntaxAlready = norm.existing_designees.some(d =>
      (d.name || '').toLowerCase().includes('moderntax') ||
      (d.name || '').toLowerCase().includes('matthew parker') ||
      (d.caf || '') === '0316-30210R'
    );
    if (moderntaxAlready) {
      norm.warnings.push('Heads up: ModernTax (CAF 0316-30210R) is already listed as a designee on this 8821 — you may not need a new one.');
    }

    return norm;
  } catch (err) {
    console.error('[extract-8821-vision] Unexpected error:', err);
    return empty('fallback', [
      `Vision extraction threw: ${err instanceof Error ? err.message : 'unknown'}. Type the fields in manually.`,
    ]);
  }
}
