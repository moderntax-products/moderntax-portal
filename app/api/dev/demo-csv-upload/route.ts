/**
 * Dev-only "dry-run" endpoint for demoing the CSV + pre-signed 8821 flow
 * without writing to the database, calling Anthropic vision, or sending
 * emails. CsvUploadFlow POSTs here instead of /api/upload/csv when the
 * page is loaded with ?demo=1.
 *
 * Behavior:
 *   - Parses the CSV / xlsx like the real route does (just enough to
 *     pull entity_name + tid for matching).
 *   - "Extracts" the TIN from each PDF by reading a digit pattern out
 *     of the filename (e.g. "8821_12-3456789.pdf" → TIN 123456789).
 *     This replaces the real vision call so the demo is deterministic
 *     and free.
 *   - Runs the same match-by-normalized-TID logic as bulkAttachPresigned8821s.
 *   - Returns the same JSON shape (success: true, entities_created,
 *     bulk_8821: { attached, unmatched_pdfs, unmatched_entities, errors }).
 *
 * Hard-gated on NODE_ENV !== 'production' so this route 404s in prod.
 */

import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizeTid(t: string | null | undefined): string {
  return (t || '').replace(/\D/g, '');
}

/**
 * Pull a TIN out of a filename. Looks for an EIN-shaped (XX-XXXXXXX) or
 * SSN-shaped (XXX-XX-XXXX) hyphenated run first so the "8821" form prefix
 * in `signed-8821_12-3456789_acme.pdf` doesn't get mis-extracted. Falls
 * back to the last contiguous 9-digit run if no hyphenated form is found.
 */
function extractTinFromFilename(name: string): string | null {
  // EIN-shaped: XX-XXXXXXX. No \b — JS treats `_` as a word char, so an
  // underscore-flanked TIN ("..._12-3456789_...") wouldn't match with \b.
  const ein = name.match(/\d{2}-\d{7}/);
  if (ein) return ein[0];
  const ssn = name.match(/\d{3}-\d{2}-\d{4}/);
  if (ssn) return ssn[0];
  // Fallback: last contiguous 9+ digit run (skips a leading "8821" form prefix).
  const all = name.match(/\d{9,}/g);
  if (all && all.length > 0) return all[all.length - 1].slice(0, 9);
  return null;
}

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const loanNumber = (formData.get('loan_number') as string | null)?.trim() || '';
    if (!file) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    if (!loanNumber) return NextResponse.json({ error: 'Loan number is required' }, { status: 400 });

    // Parse the CSV/xlsx the same way CsvUploadFlow does on the client.
    const buf = Buffer.from(await file.arrayBuffer());
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
    type DemoEntity = { id: string; entity_name: string; tid: string };
    const entities: DemoEntity[] = rows.map((raw, i) => {
      const norm: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) norm[k.trim().toLowerCase().replace(/\s+/g, '_')] = String(v ?? '').trim();
      return {
        id: `demo-${i + 1}`,
        entity_name: norm['legal_name'] || norm['legalname'] || `Entity ${i + 1}`,
        tid: norm['tid'] || '',
      };
    });

    // Collect signed_8821_N PDFs.
    const pdfs: Array<{ filename: string; size: number }> = [];
    for (let i = 0; i < 15; i++) {
      const f = formData.get(`signed_8821_${i}`) as File | null;
      if (!f) continue;
      pdfs.push({ filename: f.name, size: f.size });
    }

    // Index entities by normalized TID and match each PDF.
    const byTid = new Map<string, DemoEntity>();
    for (const e of entities) if (e.tid) byTid.set(normalizeTid(e.tid), e);

    const attached: Array<{ entityId: string; entityName: string; filename: string; storagePath: string }> = [];
    const unmatched_pdfs: Array<{ filename: string; extractedTid: string | null; reason: string }> = [];
    const errors: Array<{ filename?: string; error: string }> = [];

    for (const pdf of pdfs) {
      const extracted = extractTinFromFilename(pdf.filename);
      if (!extracted) {
        unmatched_pdfs.push({ filename: pdf.filename, extractedTid: null, reason: 'Demo: no 9-digit TIN found in filename (use e.g. "8821_12-3456789.pdf")' });
        continue;
      }
      const norm = normalizeTid(extracted);
      const ent = byTid.get(norm);
      if (!ent) {
        unmatched_pdfs.push({ filename: pdf.filename, extractedTid: extracted, reason: `No entity in this submission has TID ${extracted}` });
        continue;
      }
      attached.push({
        entityId: ent.id,
        entityName: ent.entity_name,
        filename: pdf.filename,
        storagePath: `8821/${ent.id}/${Date.now()}-bulk-csv.pdf`,
      });
      byTid.delete(norm);
    }

    const unmatched_entities = Array.from(byTid.values()).map((e) => ({ id: e.id, name: e.entity_name, tid: e.tid }));

    return NextResponse.json({
      success: true,
      demo_mode: true,
      batch_id: 'demo-batch',
      request_id: 'demo-request',
      requests_created: 1,
      entities_created: entities.length,
      loan_numbers: [loanNumber],
      bulk_8821: { attached, unmatched_pdfs, unmatched_entities, errors },
    });
  } catch (err: any) {
    console.error('[demo-csv-upload]', err);
    return NextResponse.json({ error: err?.message || 'Demo failed' }, { status: 500 });
  }
}
