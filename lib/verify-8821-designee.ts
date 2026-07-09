/**
 * 8821 designee ↔ assigned-expert CAF verification.
 *
 * Experts must be served the 8821 copy that names THEIR CAF as a designee.
 * Serving a wrong-designee form (e.g. the processor's original, or another
 * expert's copy) caused an expert to reject the work and miss an IRS callback
 * (Joel Abernathy, 2026-06-03). This module extracts the designee CAF(s) from
 * an 8821 PDF so the upload flow can approve the expert copy only on a match.
 *
 * The IRS 8821 names up to two designees, each with a CAF No. — we collect ALL
 * CAF-shaped strings from the AcroForm field values AND the rendered text
 * (flattened/e-signed copies have no form fields), then check the expert's CAF
 * is among them.
 */
import { PDFDocument, PDFTextField } from 'pdf-lib';

const CAF_RE = /\b0\d{3}[-\s]?\d{5}[-\s]?[A-Za-z]\b/g;

/** Strip separators + uppercase so "0312-78018R" and "031278018r" compare equal. */
export function normalizeCaf(c: string | null | undefined): string {
  return (c || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

/** All distinct CAF-shaped strings found in the 8821 (form fields + text). */
export async function extractDesigneeCafs(pdf: Buffer): Promise<string[]> {
  const found = new Set<string>();

  // 1. AcroForm text-field values (fillable copies)
  try {
    const doc = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false });
    const form = doc.getForm();
    for (const f of form.getFields()) {
      try {
        const tf = f as PDFTextField;
        const v = typeof tf.getText === 'function' ? tf.getText() : null;
        if (v) for (const m of v.match(CAF_RE) || []) found.add(normalizeCaf(m));
      } catch { /* not a text field */ }
    }
  } catch { /* not a valid AcroForm */ }

  // 2. Rendered text (flattened / e-signed copies have no form fields)
  try {
    const pdfParse = (await import('pdf-parse')).default as (b: Buffer) => Promise<{ text: string }>;
    const { text } = await pdfParse(pdf);
    for (const m of (text || '').match(CAF_RE) || []) found.add(normalizeCaf(m));
  } catch { /* text extraction failed — fields may still have caught it */ }

  return Array.from(found);
}

/**
 * Vision fallback for scanned/flattened 8821s. Wet-signed scans (Centerstone,
 * A&H Development 2026-07-09) have NO form fields and an empty text layer, so
 * extractDesigneeCafs returns [] and the gate false-blocked a correct form.
 * extract8821WithVision reads the page as an image and returns the Section 2
 * designees. `available` is false when the vision call couldn't run (no API
 * key / API error) — callers treat that as "couldn't validate", not "no match".
 */
async function extractDesigneeCafsViaVision(pdf: Buffer): Promise<{ cafs: string[]; available: boolean }> {
  try {
    const { extract8821WithVision } = await import('./extract-8821-vision');
    const r = await extract8821WithVision(pdf);
    if (r.source !== 'vision') return { cafs: [], available: false };
    const cafs = new Set<string>();
    for (const d of r.existing_designees || []) {
      for (const m of (d.caf || '').match(CAF_RE) || []) cafs.add(normalizeCaf(m));
      // Some scans render the CAF without separators — accept a bare code too.
      const bare = normalizeCaf(d.caf);
      if (/^0\d{8}[A-Z]$/.test(bare)) cafs.add(bare);
    }
    return { cafs: Array.from(cafs), available: true };
  } catch {
    return { cafs: [], available: false };
  }
}

export interface DesigneeCheck {
  ok: boolean;
  expertCaf: string | null;
  designeeCafs: string[];
  reason?: string;
  /** How the designees were read: form fields/text layer, vision (scan), or not at all. */
  source?: 'text' | 'vision' | 'unvalidated';
}

/**
 * True if the expert's CAF appears among the 8821's designee CAFs.
 *
 * Read order: AcroForm fields + text layer first; if that finds NO CAFs at all
 * (wet-signed scans have an empty text layer), fall back to vision extraction.
 * Fail-open cases (ok=true with a reason, caller may surface a warning):
 *   - expert has no CAF on file (nothing to compare), or
 *   - the document is unreadable by BOTH text and vision (vision unavailable) —
 *     an admin must verify the designee visually; blocking here left no path
 *     forward at all (A&H Development, 2026-07-09).
 * A readable document that does NOT name the expert's CAF still hard-fails.
 */
export async function verify8821Designee(pdf: Buffer, expertCaf: string | null | undefined): Promise<DesigneeCheck> {
  const designeeCafs = await extractDesigneeCafs(pdf);
  const norm = normalizeCaf(expertCaf);
  if (!norm) return { ok: true, expertCaf: expertCaf || null, designeeCafs, reason: 'expert has no CAF on file — not validated', source: designeeCafs.length ? 'text' : 'unvalidated' };

  if (designeeCafs.length > 0) {
    const ok = designeeCafs.includes(norm);
    return {
      ok,
      expertCaf: expertCaf || null,
      designeeCafs,
      reason: ok ? undefined : `expert CAF ${expertCaf} not among 8821 designees [${designeeCafs.join(', ')}]`,
      source: 'text',
    };
  }

  // Text layer empty → scanned form. Try vision.
  const vision = await extractDesigneeCafsViaVision(pdf);
  if (vision.available) {
    const ok = vision.cafs.includes(norm);
    return {
      ok,
      expertCaf: expertCaf || null,
      designeeCafs: vision.cafs,
      reason: ok ? undefined : `expert CAF ${expertCaf} not among 8821 designees [${vision.cafs.join(', ') || 'none found'}] (read from scan via vision)`,
      source: 'vision',
    };
  }

  // Unreadable by both paths — can't validate. Don't dead-end the upload;
  // surface a warning so the admin verifies the designee by eye.
  return {
    ok: true,
    expertCaf: expertCaf || null,
    designeeCafs: [],
    reason: 'scanned form with no readable text and vision unavailable — designee NOT validated; verify the CAF on the form manually',
    source: 'unvalidated',
  };
}
