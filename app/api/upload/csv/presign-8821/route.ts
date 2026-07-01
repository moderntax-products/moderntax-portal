/**
 * Signed-upload-URL minter for pre-signed 8821 PDFs (CSV bulk-intake flow).
 *
 * POST /api/upload/csv/presign-8821
 *
 * Why this exists:
 * The CSV bulk-upload (components/CsvUploadFlow.tsx → /api/upload/csv) used
 * to POST the spreadsheet AND every pre-signed 8821 PDF inline in one
 * multipart request. Centerstone-style scanned 8821s run ~4 MB each, so a
 * loan with 4+ entities blew past Vercel's ~4.5 MB serverless request-body
 * ceiling — the POST was rejected before the handler ran and the processor
 * only saw a generic error.
 *
 * Fix: the client uploads each PDF straight to Supabase Storage via a
 * short-lived signed upload URL minted here (service-role, so no per-user
 * storage RLS is required), then POSTs only the resulting storage paths to
 * /api/upload/csv. That removes the body-size ceiling entirely — the big
 * bytes never transit the API route.
 *
 * Request (JSON):
 *   { files: [{ name: string }, ...] }   // max 15, matching the loan cap
 *
 * Response (JSON):
 *   { uploads: [{ path, token, filename }, ...] }
 *
 * The client feeds each { path, token } to
 * supabase.storage.from('uploads').uploadToSignedUrl(path, token, file),
 * then sends the { path, filename } list to /api/upload/csv as
 * `presigned_8821_paths`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';

// Mirror the CSV upload cap: max 15 pre-signed 8821s per loan.
const MAX_PDFS = 15;

/** Make a storage-safe object name — strip anything that isn't a basename char. */
function safeName(name: string): string {
  const base = (name || 'signed-8821.pdf').split(/[\\/]/).pop() || 'signed-8821.pdf';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned}.pdf`;
}

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = (await supabase
      .from('profiles')
      .select('client_id')
      .eq('id', user.id)
      .single()) as { data: { client_id: string | null } | null; error: unknown };

    if (!profile?.client_id) {
      return NextResponse.json({ error: 'No client associated' }, { status: 400 });
    }

    let body: { files?: Array<{ name?: string }> };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0) {
      return NextResponse.json({ error: 'No files requested' }, { status: 400 });
    }
    if (files.length > MAX_PDFS) {
      return NextResponse.json(
        { error: `Maximum ${MAX_PDFS} pre-signed 8821 PDFs per upload.` },
        { status: 400 },
      );
    }

    const admin = createAdminClient();
    const ts = Date.now();
    const uploads: Array<{ path: string; token: string; filename: string }> = [];

    for (let i = 0; i < files.length; i++) {
      const filename = safeName(files[i]?.name || `signed-8821-${i}.pdf`);
      // Transient inbox path scoped to the client. /api/upload/csv downloads
      // from here, then bulk-8821-attach re-uploads matched PDFs to the
      // canonical 8821/{entity_id}/... path and the inbox copy is cleaned up.
      const path = `8821-inbox/${profile.client_id}/${ts}-${i}-${filename}`;
      const { data, error } = await admin.storage
        .from('uploads')
        .createSignedUploadUrl(path);
      if (error || !data) {
        console.error('[presign-8821] createSignedUploadUrl failed:', error);
        return NextResponse.json(
          { error: `Failed to prepare upload for ${filename}: ${error?.message || 'unknown error'}` },
          { status: 500 },
        );
      }
      uploads.push({ path: data.path, token: data.token, filename });
    }

    return NextResponse.json({ uploads });
  } catch (err) {
    console.error('[presign-8821] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to prepare uploads' },
      { status: 500 },
    );
  }
}
