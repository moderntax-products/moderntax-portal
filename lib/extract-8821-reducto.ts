/**
 * Reducto-backed extraction of the taxpayer identity (name + TIN) from an IRS
 * Form 8821 PDF. Purpose-built document extraction — more reliable than the
 * generic vision fallback for pulling a TIN off a flattened/scanned signed
 * 8821, which is exactly the disambiguation the email-intake matcher needs.
 *
 * Flow (per Reducto API): POST /upload (multipart) → file_id → POST /extract
 * with a JSON schema. Bearer auth with REDUCTO_API_KEY.
 *
 * Fully optional + fail-safe: if REDUCTO_API_KEY isn't set or anything errors,
 * we return nulls and the caller falls back (vision, then hold-for-triage) —
 * a Reducto outage can never mis-file or crash the webhook.
 */

const REDUCTO_BASE = process.env.REDUCTO_BASE_URL || 'https://platform.reducto.ai';

export interface ReductoTaxpayer {
  taxpayer_name: string | null;
  tin: string | null;
}

const EMPTY: ReductoTaxpayer = { taxpayer_name: null, tin: null };

export function reductoConfigured(): boolean {
  return !!process.env.REDUCTO_API_KEY;
}

export async function extract8821WithReducto(pdfBuffer: Buffer | Uint8Array): Promise<ReductoTaxpayer> {
  const apiKey = process.env.REDUCTO_API_KEY;
  if (!apiKey) return EMPTY;

  try {
    // 1. Upload the PDF bytes → { file_id }.
    const fd = new FormData();
    fd.append('file', new Blob([pdfBuffer as unknown as BlobPart], { type: 'application/pdf' }), '8821.pdf');
    const upRes = await fetch(`${REDUCTO_BASE}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });
    if (!upRes.ok) throw new Error(`upload HTTP ${upRes.status}`);
    const up: any = await upRes.json().catch(() => ({}));
    const fileId: string | undefined = up.file_id || up.fileId;
    if (!fileId) throw new Error('upload returned no file_id');

    // 2. Structured extraction of Section 1 (taxpayer name + TIN).
    const exRes = await fetch(`${REDUCTO_BASE}/extract`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: `reducto://${fileId}`,
        instructions: {
          schema: {
            type: 'object',
            properties: {
              taxpayer_name: { type: 'string', description: 'Line 1 taxpayer name on the IRS Form 8821' },
              tin: { type: 'string', description: 'Taxpayer Identification Number — EIN as XX-XXXXXXX or SSN as XXX-XX-XXXX' },
            },
          },
          system_prompt: 'Extract the taxpayer name and TIN from Section 1 of this IRS Form 8821. Be precise. If a value is not present, return null — do not guess.',
        },
      }),
    });
    if (!exRes.ok) throw new Error(`extract HTTP ${exRes.status}`);
    const data: any = await exRes.json().catch(() => ({}));

    // Sync V3ExtractResponse returns the schema object; be defensive about a
    // possible result/data wrapper across API versions.
    const fields = (data && typeof data === 'object')
      ? (data.result ?? data.data ?? data)
      : {};
    return {
      taxpayer_name: (fields?.taxpayer_name ?? null) || null,
      tin: (fields?.tin ?? null) || null,
    };
  } catch (e: any) {
    console.warn('[reducto-8821] extract failed:', e?.message || e);
    return EMPTY;
  }
}
