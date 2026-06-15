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

export interface DesigneeCheck {
  ok: boolean;
  expertCaf: string | null;
  designeeCafs: string[];
  reason?: string;
}

/**
 * True if the expert's CAF appears among the 8821's designee CAFs. If the
 * expert has no CAF on file we CAN'T validate — return ok (don't block), with
 * a reason, so the caller can decide to warn rather than hard-fail.
 */
export async function verify8821Designee(pdf: Buffer, expertCaf: string | null | undefined): Promise<DesigneeCheck> {
  const designeeCafs = await extractDesigneeCafs(pdf);
  const norm = normalizeCaf(expertCaf);
  if (!norm) return { ok: true, expertCaf: expertCaf || null, designeeCafs, reason: 'expert has no CAF on file — not validated' };
  const ok = designeeCafs.includes(norm);
  return {
    ok,
    expertCaf: expertCaf || null,
    designeeCafs,
    reason: ok ? undefined : `expert CAF ${expertCaf} not among 8821 designees [${designeeCafs.join(', ') || 'none found'}]`,
  };
}
