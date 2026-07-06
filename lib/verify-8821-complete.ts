/**
 * 8821 completeness verification (pre-assignment gate).
 *
 * Uploaded 8821s — Centerstone's flat-rate bulk-attach and the single-PDF
 * fallback — are attached to an entity as whatever file the processor sent,
 * with NO check that the form is actually complete. A blank, unsigned,
 * wrong-taxpayer, or mismatched-designee 8821 would sail through to an expert,
 * who then wastes a call the IRS rejects. This module vision-reads the attached
 * 8821 and confirms it's complete BEFORE the entity is eligible for assignment:
 *
 *   1. Taxpayer TIN present + matches the entity's TID (right taxpayer)
 *   2. Signed — a Section 6 signer name or signed date is present
 *   3. ModernTax is a named designee (house CAF 0316-30210R) so we're authorized
 *
 * Vision is required because Centerstone's 8821s are flattened scans/photos
 * with no text layer or AcroForm — the text-based extractors return nothing.
 * App-generated 8821s (Dropbox Sign, identified by signature_id) are inherently
 * complete and are NOT sent here.
 */

import { extract8821WithVision } from './extract-8821-vision';

/** ModernTax's house designee CAF — must appear as an 8821 designee. */
export const MODERNTAX_HOUSE_CAF = '0316-30210R';

const normTid = (t: string | null | undefined) => (t || '').replace(/\D/g, '');
const normCaf = (c: string | null | undefined) => (c || '').replace(/[^a-z0-9]/gi, '').toUpperCase();

export interface EightyoneCompleteness {
  ok: boolean;
  tinMatch: boolean;
  signed: boolean;
  designeeOk: boolean;
  extractedTin: string | null;
  taxpayerName: string | null;
  designeeCafs: string[];
  /** true when vision couldn't run (missing key / API error) — caller should NOT hard-fail. */
  inconclusive: boolean;
  reason: string;
}

/**
 * Vision-verify an uploaded 8821 against the entity's TID. Never throws —
 * returns an inconclusive result on infrastructure failure so a vision outage
 * holds (doesn't falsely reject) the entity.
 */
export async function verify8821Complete(pdf: Buffer, entityTid: string): Promise<EightyoneCompleteness> {
  let v: Awaited<ReturnType<typeof extract8821WithVision>>;
  try {
    v = await extract8821WithVision(pdf);
  } catch (err: any) {
    return {
      ok: false, tinMatch: false, signed: false, designeeOk: false,
      extractedTin: null, taxpayerName: null, designeeCafs: [], inconclusive: true,
      reason: `vision extraction threw: ${err?.message || err}`,
    };
  }

  if (v.source === 'fallback') {
    return {
      ok: false, tinMatch: false, signed: false, designeeOk: false,
      extractedTin: null, taxpayerName: null, designeeCafs: [], inconclusive: true,
      reason: `vision unavailable (${v.warnings?.join('; ') || 'fallback'}) — not verified, will retry`,
    };
  }

  const wantTid = normTid(entityTid);
  const extractedTin = v.tin ? normTid(v.tin) : null;
  const tinMatch = !!extractedTin && !!wantTid && extractedTin === wantTid;

  const signed = !!(v.signer_name?.trim() || v.signed_date?.trim());

  const designeeCafs = (v.existing_designees || [])
    .map((d) => normCaf(d.caf))
    .filter(Boolean);
  const designeeOk = designeeCafs.includes(normCaf(MODERNTAX_HOUSE_CAF));

  const ok = tinMatch && signed && designeeOk;

  const problems: string[] = [];
  if (!tinMatch) {
    problems.push(extractedTin
      ? `taxpayer TIN on the 8821 (…${extractedTin.slice(-4)}) does not match this entity (…${wantTid.slice(-4)})`
      : 'no taxpayer TIN could be read from the 8821 (Section 1 blank or unreadable)');
  }
  if (!signed) problems.push('the 8821 is not signed (Section 6 has no signer name or date)');
  if (!designeeOk) {
    problems.push(`ModernTax (CAF ${MODERNTAX_HOUSE_CAF}) is not a named designee${designeeCafs.length ? ` — found [${designeeCafs.join(', ')}]` : ''}`);
  }

  return {
    ok,
    tinMatch,
    signed,
    designeeOk,
    extractedTin,
    taxpayerName: v.taxpayer_name,
    designeeCafs,
    inconclusive: false,
    reason: ok ? 'complete' : problems.join('; '),
  };
}
