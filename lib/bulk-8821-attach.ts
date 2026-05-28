/**
 * Bulk-attach pre-signed 8821 PDFs to entities created via CSV intake.
 *
 * Driver: 2026-05-27 Matt + Mathew Paek call — Centerstone is going
 * back to flat-rate-only by uploading pre-signed 8821s themselves (no
 * Dropbox Sign surcharge). This helper bridges the existing CSV upload
 * with the existing /api/intake/8821-pdf single-PDF flow so processors
 * can submit a CSV + up to 15 signed 8821 PDFs in one shot.
 *
 * Flow:
 *   1. Caller passes the freshly-created entities + an array of
 *      {filename, buffer} PDFs.
 *   2. For each PDF: extract TIN via vision API (or text fallback).
 *   3. Match PDF to entity by normalized TID.
 *   4. Upload matched PDF to storage at the same path the single-PDF
 *      intake uses (8821/{entity_id}/{ts}-bulk-csv.pdf).
 *   5. Update entity: signed_8821_url + status='8821_signed' +
 *      signature_created_at.
 *   6. Return per-entity match results so the caller can:
 *      - Skip Dropbox Sign for matched entities
 *      - Surface unmatched entities + unmatched PDFs to the UI
 *      - Enforce the "all-or-nothing" rule for clients with
 *        disable_8821_surcharge=true (Centerstone).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { extract8821WithVision } from './extract-8821-vision';

export interface BulkPdf {
  filename: string;
  buffer: Buffer;
}

export interface EntityForMatch {
  id: string;
  entity_name: string;
  tid: string | null;
  tid_kind: string | null;
  status: string;
  signed_8821_url: string | null;
}

export interface BulkAttachResult {
  /** PDFs that matched an entity and were attached. */
  attached: Array<{ entityId: string; entityName: string; filename: string; storagePath: string }>;
  /** PDFs that were uploaded but didn't match any entity. Surfaces to UI as warnings. */
  unmatchedPdfs: Array<{ filename: string; extractedTid: string | null; reason: string }>;
  /** Entities that still need an 8821 (no pre-signed PDF, repeat-completed excluded). */
  unmatchedEntities: EntityForMatch[];
  /** Errors during extraction or upload — non-fatal but surfaced for ops visibility. */
  errors: Array<{ filename?: string; entityId?: string; error: string }>;
}

/** Strip dashes / spaces / non-digits from a TID for comparison. */
function normalizeTid(t: string | null | undefined): string {
  return (t || '').replace(/\D/g, '');
}

export async function bulkAttachPresigned8821s(
  admin: SupabaseClient,
  entities: EntityForMatch[],
  pdfs: BulkPdf[],
): Promise<BulkAttachResult> {
  const attached: BulkAttachResult['attached'] = [];
  const unmatchedPdfs: BulkAttachResult['unmatchedPdfs'] = [];
  const errors: BulkAttachResult['errors'] = [];

  // Index entities by normalized TID for matching
  // (only entities that still need an 8821 — skip repeat-completed)
  const entityByTid = new Map<string, EntityForMatch>();
  for (const e of entities) {
    if (e.signed_8821_url) continue;       // already attached (repeat-entity flow)
    if (e.status === 'completed') continue;
    if (!e.tid) continue;
    entityByTid.set(normalizeTid(e.tid), e);
  }

  for (const pdf of pdfs) {
    let extractedTid: string | null = null;
    try {
      const extracted = await extract8821WithVision(pdf.buffer);
      extractedTid = extracted.tin;
    } catch (err: any) {
      errors.push({ filename: pdf.filename, error: `vision extraction failed: ${err?.message || err}` });
      unmatchedPdfs.push({ filename: pdf.filename, extractedTid: null, reason: 'TID extraction failed' });
      continue;
    }

    if (!extractedTid) {
      unmatchedPdfs.push({ filename: pdf.filename, extractedTid: null, reason: 'No TIN found on the form (Section 1 blank or unreadable)' });
      continue;
    }

    const normTid = normalizeTid(extractedTid);
    const matchedEntity = entityByTid.get(normTid);
    if (!matchedEntity) {
      unmatchedPdfs.push({
        filename: pdf.filename,
        extractedTid,
        reason: `No entity in this submission has TID ${extractedTid}`,
      });
      continue;
    }

    // Upload to storage — same path convention as /api/intake/8821-pdf
    const storagePath = `8821/${matchedEntity.id}/${Date.now()}-bulk-csv.pdf`;
    const { error: uploadErr } = await admin.storage.from('uploads')
      .upload(storagePath, pdf.buffer, { contentType: 'application/pdf', upsert: false });
    if (uploadErr) {
      errors.push({ filename: pdf.filename, entityId: matchedEntity.id, error: `storage upload failed: ${uploadErr.message}` });
      unmatchedPdfs.push({ filename: pdf.filename, extractedTid, reason: `Upload failed: ${uploadErr.message}` });
      continue;
    }

    // Update entity record
    const updateFields: Record<string, unknown> = {
      signed_8821_url: storagePath,
      signature_created_at: new Date().toISOString(),
    };
    if (['pending', 'submitted', '8821_sent'].includes(matchedEntity.status)) {
      updateFields.status = '8821_signed';
    }
    const { error: updateErr } = await (admin.from('request_entities') as any)
      .update(updateFields)
      .eq('id', matchedEntity.id);
    if (updateErr) {
      errors.push({ filename: pdf.filename, entityId: matchedEntity.id, error: `entity update failed: ${updateErr.message}` });
      continue;
    }

    // Mark this entity as attached so it won't match again + so callers
    // can see it's done (also update in-memory so the entity list
    // returned reflects the new state).
    matchedEntity.signed_8821_url = storagePath;
    matchedEntity.status = updateFields.status as string || matchedEntity.status;
    entityByTid.delete(normTid);

    attached.push({
      entityId: matchedEntity.id,
      entityName: matchedEntity.entity_name,
      filename: pdf.filename,
      storagePath,
    });
  }

  // Anything still in entityByTid is unmatched (no PDF supplied for it)
  const unmatchedEntities = [...entityByTid.values()];

  return { attached, unmatchedPdfs, unmatchedEntities, errors };
}
