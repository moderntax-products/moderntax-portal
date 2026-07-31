/**
 * Sinch Fax API client (v3) — replaces the broken offline Fax.plus workflow.
 *
 * Experts fax signed 8821s to the IRS (CAF unit, or the number a PPS rep gives
 * on a call) directly from the expert dashboard instead of an external fax
 * tool. Sinch pulls the document from a URL, so we hand it a short-lived
 * signed Supabase storage URL — the file itself never routes through us twice.
 *
 * Env (Vercel):
 *   SINCH_PROJECT_ID     — dashboard.sinch.com project id
 *   SINCH_ACCESS_KEY     — access key id
 *   SINCH_ACCESS_SECRET  — access key secret (shown once at creation)
 *   SINCH_FAX_FROM       — one or more purchased Sinch fax numbers (E.164).
 *                          Comma-separate for a pool, e.g.
 *                          "+12082665230,+12082665244" — a given expert is
 *                          pinned to one number so the IRS sees a stable sender.
 *
 * Basic auth per Sinch's quickstart; move to OAuth if volume warrants
 * (fax-plus tripwire memory: 10+ experts OR 200+ faxes/mo).
 */

const SINCH_BASE = 'https://fax.api.sinch.com/v3';

export interface SinchFaxResult {
  id: string;
  status: string; // QUEUED | IN_PROGRESS | COMPLETED | FAILURE (per Sinch docs)
  to: string;
  createTime?: string;
}

export function sinchConfigured(): boolean {
  return !!(process.env.SINCH_PROJECT_ID && process.env.SINCH_ACCESS_KEY && process.env.SINCH_ACCESS_SECRET);
}

/**
 * A US NANP number is +1 NXX NXX XXXX where N ∈ 2–9 (the area code and the
 * exchange code may not start with 0 or 1). Sinch rejects anything that isn't a
 * valid E.164 destination with a bare 422 "Unprocessable Entity", so we screen
 * out the common typos here — a mistyped area/exchange code — and return null,
 * which the route turns into a clear "enter a valid fax number" 400 instead of
 * an opaque 502 the expert can't act on.
 */
function isValidUsNanp(tenDigits: string): boolean {
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(tenDigits);
}

/** Normalize a US fax number to E.164 (+1XXXXXXXXXX). Returns null if unusable. */
export function normalizeFaxNumber(raw: string | null | undefined): string | null {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return isValidUsNanp(digits) ? `+1${digits}` : null;
  if (digits.length === 11 && digits.startsWith('1')) {
    const local = digits.slice(1);
    return isValidUsNanp(local) ? `+1${local}` : null;
  }
  // Escape hatch for a caller-supplied +E.164 (rare — IRS fax is always US):
  // trust it only at a plausible international length.
  if ((raw || '').trim().startsWith('+') && digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** Parse SINCH_FAX_FROM (single number or comma-separated pool) → E.164 list. */
export function getFaxFromPool(): string[] {
  return (process.env.SINCH_FAX_FROM || '')
    .split(',')
    .map((n) => normalizeFaxNumber(n))
    .filter((n): n is string => !!n);
}

/**
 * Pick a from-number from the pool. A stable `seed` (e.g. the expert's id)
 * pins that expert to the same sender number so the IRS sees a consistent
 * fax CSID; with no seed we spread across the pool.
 */
export function pickFaxFrom(seed?: string): string | null {
  const pool = getFaxFromPool();
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];
  if (seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return pool[h % pool.length];
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

export async function sendSinchFax(input: {
  to: string;          // E.164
  contentUrl: string;  // URL Sinch pulls + renders (our signed storage URL)
  callbackUrl?: string;
  headerText?: string; // printed on the fax header line
  fromSeed?: string;   // stable sender selection from the pool (e.g. expert id)
}): Promise<SinchFaxResult> {
  if (!sinchConfigured()) throw new Error('Sinch fax not configured — set SINCH_PROJECT_ID / SINCH_ACCESS_KEY / SINCH_ACCESS_SECRET');

  const auth = Buffer.from(`${process.env.SINCH_ACCESS_KEY}:${process.env.SINCH_ACCESS_SECRET}`).toString('base64');
  const body: Record<string, unknown> = {
    to: input.to,
    contentUrl: input.contentUrl,
  };
  if (input.callbackUrl) body.callbackUrl = input.callbackUrl;
  const fromNumber = pickFaxFrom(input.fromSeed);
  if (fromNumber) body.from = fromNumber;
  // Sinch caps the fax header line at 50 characters and 422s the whole request
  // if it's longer (confirmed by Sinch support). Enforce it here — the single
  // Sinch boundary — so no caller can trip it. trim() avoids sending a header
  // that's all trailing whitespace after the cut.
  if (input.headerText) {
    const header = input.headerText.slice(0, 50).trim();
    if (header) body.headerText = header;
  }

  const res = await fetch(`${SINCH_BASE}/projects/${process.env.SINCH_PROJECT_ID}/faxes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify(body),
  });

  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Sinch nests the actionable reason under error.details / violations rather
    // than the top-level message (which is often the bare status text like
    // "Unprocessable Entity"). Pull the specific field violation so the expert
    // and the logs see *why* — not just a 422.
    const nested = json?.error?.details || json?.error?.violations || json?.violations || json?.fields || [];
    const nestedMsg = (Array.isArray(nested) ? nested : [])
      .map((d: any) => d?.message || d?.description || d?.reason || d?.field)
      .filter(Boolean)
      .join('; ');
    const base = json?.error?.message || json?.message || `HTTP ${res.status}`;
    const detail = nestedMsg ? `${base} — ${nestedMsg}` : base;
    // Log the sanitized request so ops can trace an opaque provider rejection
    // (never log auth or the signed document URL's query token).
    console.error('[sinch-fax] send rejected', res.status, {
      to: input.to,
      from: body.from,
      hasContentUrl: !!input.contentUrl,
      detail,
    });
    throw new Error(`Sinch fax send failed: ${detail}`);
  }
  return {
    id: json.id || json.faxId || '',
    status: json.status || 'QUEUED',
    to: json.to || input.to,
    createTime: json.createTime,
  };
}

/** Fetch current status of a fax (fallback when the callback didn't land). */
export async function getSinchFax(faxId: string): Promise<SinchFaxResult | null> {
  if (!sinchConfigured()) return null;
  const auth = Buffer.from(`${process.env.SINCH_ACCESS_KEY}:${process.env.SINCH_ACCESS_SECRET}`).toString('base64');
  const res = await fetch(`${SINCH_BASE}/projects/${process.env.SINCH_PROJECT_ID}/faxes/${encodeURIComponent(faxId)}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) return null;
  const json: any = await res.json().catch(() => null);
  if (!json) return null;
  return { id: json.id, status: json.status, to: json.to, createTime: json.createTime };
}
