/**
 * Partner 8821-PDF intake endpoint
 *
 * POST /api/intake/8821-pdf
 *
 * Accepts an already-signed 8821 PDF binary from a partner, attaches it
 * to a specific entity within a previously-created request, and advances
 * the entity to status='8821_signed' so the existing IRS-call pipeline
 * can pick it up.
 *
 * Authenticated via `x-api-key` (SHA-256 hashed lookup, constant-time
 * verified via lib/auth-util). Mirrors the admin/upload-8821 logic but
 * uses partner-friendly identifiers (request_token + entity_name or
 * entity_id) so partners don't need to know our internal request UUID.
 *
 * Why this exists: both Moxie and Collective demos asked for it.
 * They collect the borrower signature on their own DocuSign / wet-sign
 * workflow and just want to POST the resulting PDF — no need for our
 * Dropbox Sign flow at all. Existing /api/intake/8821 is metadata-only
 * (CSV/JSON describing entities to fire signature requests for). This
 * is the binary-upload counterpart.
 *
 * Request (multipart/form-data):
 *   - x-api-key:        partner api key
 *   - file:             the signed 8821 PDF (application/pdf, < 10 MB)
 *   - request_token:    the external token used to create the request
 *   - entity_name:      (optional) which entity in the request the PDF
 *                       belongs to. Required if request has > 1 entity.
 *   - entity_id:        (optional) ModernTax entity UUID (alternative to
 *                       entity_name; takes precedence if both supplied).
 *   - years:            (optional) comma-separated or range, e.g.
 *                       "2022,2023,2024" or "2022-2024". If omitted, the
 *                       entity's existing years are kept.
 *   - form_type:        (optional) override form type (e.g. "1120S").
 *
 * Response: { success, entity: { id, name, status, signed_8821_url } }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { sha256Hex, safeEqual } from '@/lib/auth-util';
import { extractEmailsFrom8821 } from '@/lib/extract-8821-pdf';
import { validateFormTypeMatchesTidKind } from '@/lib/form-type-validation';
import type { Database } from '@/lib/database.types';

type EntityUpdate = Database['public']['Tables']['request_entities']['Update'];

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Parse year input. Accepts "2022,2023,2024" or "2022-2024" or single
 * "2024". Returns sorted unique year strings, or null on any malformed
 * input (caller treats null as "leave entity.years unchanged"). 8821
 * covers 1990 → 2028 per IRS spec; matches the validator in
 * /api/admin/upload-8821.
 */
function parseYears(input: string | null): string[] | null {
  if (!input || !input.trim()) return null;
  const out = new Set<string>();
  const currentYear = new Date().getFullYear();
  const MAX_YEAR = Math.max(currentYear + 1, 2028);
  const tokens = input.split(/[,;\n]+/).map(t => t.trim()).filter(Boolean);
  for (const token of tokens) {
    const range = token.match(/^(\d{4})\s*[-–—to]+\s*(\d{4})$/i);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      if (a > b || a < 1990 || b > MAX_YEAR) return null;
      for (let y = a; y <= b; y++) out.add(String(y));
      continue;
    }
    const single = token.match(/^(\d{4})$/);
    if (single) {
      const y = parseInt(single[1], 10);
      if (y < 1990 || y > MAX_YEAR) return null;
      out.add(String(y));
      continue;
    }
    return null;
  }
  return out.size > 0 ? Array.from(out).sort() : null;
}

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB

export async function POST(request: NextRequest) {
  try {
    // --- Auth (constant-time, hash-based; see lib/auth-util) ---
    const apiKey = request.headers.get('x-api-key');
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing x-api-key header' }, { status: 401 });
    }

    const supabase = createAdminClient();
    const presentedHash = sha256Hex(apiKey);

    const { data: client } = await supabase
      .from('clients')
      .select('id, name, slug, api_key_hash')
      .eq('api_key_hash', presentedHash)
      .single() as { data: { id: string; name: string; slug: string; api_key_hash: string } | null };

    if (!client || !safeEqual(client.api_key_hash, presentedHash)) {
      return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    }

    // --- Parse multipart body ---
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return NextResponse.json(
        { error: 'Content-Type must be multipart/form-data' },
        { status: 400 },
      );
    }

    const form = await request.formData();
    const file = form.get('file') as File | null;
    const requestToken = (form.get('request_token') as string | null)?.trim() || '';
    const entityName = (form.get('entity_name') as string | null)?.trim() || null;
    const entityIdInput = (form.get('entity_id') as string | null)?.trim() || null;
    const yearsInput = (form.get('years') as string | null)?.trim() || null;
    const formType = (form.get('form_type') as string | null)?.trim() || null;

    if (!file) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 });
    }
    if (!requestToken) {
      return NextResponse.json({ error: 'request_token is required' }, { status: 400 });
    }
    if (!entityName && !entityIdInput) {
      return NextResponse.json(
        { error: 'either entity_name or entity_id is required' },
        { status: 400 },
      );
    }

    // --- Validate the file (size + MIME) ---
    if (file.size > MAX_PDF_BYTES) {
      return NextResponse.json(
        { error: `file too large (max ${MAX_PDF_BYTES} bytes)` },
        { status: 400 },
      );
    }
    if (file.type && !file.type.includes('pdf')) {
      return NextResponse.json(
        { error: 'file must be a PDF' },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    // Sanity-check the magic header — browser-supplied MIME is spoofable.
    // PDF files start with "%PDF-" (0x25 0x50 0x44 0x46 0x2D).
    if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      return NextResponse.json(
        { error: 'file does not appear to be a PDF (missing %PDF- header)' },
        { status: 400 },
      );
    }

    // --- Resolve the request + entity, scoped to this client ---
    const { data: req } = await supabase
      .from('requests')
      .select('id, client_id, external_request_token')
      .eq('external_request_token', requestToken)
      .eq('client_id', client.id)
      .maybeSingle() as { data: { id: string; client_id: string; external_request_token: string } | null };

    if (!req) {
      return NextResponse.json(
        { error: 'request_token not found for your account' },
        { status: 404 },
      );
    }

    // Look up entity by id (preferred) or by name within the request.
    let entity: any = null;
    if (entityIdInput) {
      const { data } = await supabase
        .from('request_entities')
        .select('id, entity_name, request_id, status, tid_kind, signer_email, signer_first_name, signer_last_name, years, form_type')
        .eq('id', entityIdInput)
        .eq('request_id', req.id)
        .maybeSingle();
      entity = data;
    } else if (entityName) {
      // Case-insensitive match. If multiple entities have the same name in
      // one request (rare but possible), require entity_id to disambiguate.
      const { data: candidates } = await supabase
        .from('request_entities')
        .select('id, entity_name, request_id, status, tid_kind, signer_email, signer_first_name, signer_last_name, years, form_type')
        .eq('request_id', req.id)
        .ilike('entity_name', entityName) as { data: any[] | null };
      if (!candidates || candidates.length === 0) {
        // Empty match
      } else if (candidates.length > 1) {
        return NextResponse.json(
          {
            error: `multiple entities named "${entityName}" in this request — pass entity_id instead`,
            entity_ids: candidates.map(c => c.id),
          },
          { status: 409 },
        );
      } else {
        entity = candidates[0];
      }
    }

    if (!entity) {
      return NextResponse.json(
        { error: 'entity not found in request' },
        { status: 404 },
      );
    }

    // Form-type guard: same check the admin endpoint does — block an
    // EIN business from being stamped 1040, etc.
    if (formType && entity.tid_kind) {
      const mismatch = validateFormTypeMatchesTidKind(entity.tid_kind, formType);
      if (mismatch) {
        return NextResponse.json({ error: mismatch }, { status: 400 });
      }
    }

    // --- Parse + validate years (optional) ---
    const years = parseYears(yearsInput);
    if (yearsInput && !years) {
      return NextResponse.json(
        { error: 'invalid years; use "2022,2023,2024" or "2022-2024" (range 1990 to 2028)' },
        { status: 400 },
      );
    }

    // --- Upload to storage at the same path the admin endpoint uses,
    //     so downstream code (sync-8821, dropbox-sign reconciler, etc.)
    //     finds it identically.
    const filePath = `8821/${entity.id}/${Date.now()}-signed-8821.pdf`;
    const { error: uploadErr } = await supabase.storage
      .from('uploads')
      .upload(filePath, buffer, {
        contentType: 'application/pdf',
        upsert: false,
      });
    if (uploadErr) {
      console.error('[intake/8821-pdf] upload error', uploadErr);
      return NextResponse.json({ error: 'storage upload failed' }, { status: 500 });
    }

    // --- Email extraction (cheap text scan) — backfill signer_email
    //     only if not already set. Same precedence rules as admin path.
    const signerName = [entity.signer_first_name, entity.signer_last_name]
      .filter(Boolean)
      .join(' ') || null;
    let extractedSignerEmail: string | null = null;
    try {
      const ext = await extractEmailsFrom8821(buffer, signerName);
      extractedSignerEmail = ext.signerEmail || null;
    } catch (extractErr) {
      // PDF text extraction is best-effort; never block the upload on it.
      console.warn('[intake/8821-pdf] email extraction failed (non-fatal)', extractErr);
    }

    // --- Update entity ---
    const updateFields: EntityUpdate = {
      signed_8821_url: filePath,
      signature_created_at: new Date().toISOString(),
    };
    if (years) updateFields.years = years;
    if (formType) updateFields.form_type = formType;
    if (['pending', 'submitted', '8821_sent'].includes(entity.status)) {
      updateFields.status = '8821_signed';
    }
    if (!entity.signer_email && extractedSignerEmail) {
      updateFields.signer_email = extractedSignerEmail;
    }

    const { error: updateErr } = await supabase
      .from('request_entities')
      .update(updateFields)
      .eq('id', entity.id);
    if (updateErr) {
      console.error('[intake/8821-pdf] entity update failed', updateErr);
      return NextResponse.json(
        { error: 'failed to update entity record' },
        { status: 500 },
      );
    }

    // --- Audit log ---
    await logAuditFromRequest(supabase, request, {
      action: 'partner_8821_pdf_uploaded',
      resourceType: 'request_entity',
      resourceId: entity.id,
      details: {
        client_name: client.name,
        request_token: requestToken,
        entity_name: entity.entity_name,
        file_size: file.size,
        years_set: !!years,
        form_type_set: !!formType,
        extracted_signer_email: extractedSignerEmail,
      },
    });

    // --- Build a signed URL for the partner's confirmation receipt ---
    const { data: signed } = await supabase.storage
      .from('uploads')
      .createSignedUrl(filePath, 3600);

    return NextResponse.json({
      success: true,
      entity: {
        id: entity.id,
        name: entity.entity_name,
        status: updateFields.status || entity.status,
        signed_8821_url: signed?.signedUrl || null,
        years: updateFields.years || entity.years,
        form_type: updateFields.form_type || entity.form_type,
      },
    });
  } catch (err) {
    console.error('[intake/8821-pdf] unexpected error', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
