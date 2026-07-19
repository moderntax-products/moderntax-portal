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

/** Normalize a US fax number to E.164 (+1XXXXXXXXXX). Returns null if unusable. */
export function normalizeFaxNumber(raw: string | null | undefined): string | null {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if ((raw || '').trim().startsWith('+') && digits.length >= 8) return `+${digits}`;
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
  if (input.headerText) body.headerText = input.headerText.slice(0, 60);

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
    const detail = json?.error?.message || json?.message || `HTTP ${res.status}`;
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
