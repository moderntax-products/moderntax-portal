/**
 * POST /api/upload/sign-8821
 *
 * Issue short-lived signed upload URLs so the BROWSER can put 8821 PDFs
 * straight into Supabase Storage, bypassing the API route entirely.
 *
 * Why this exists: Vercel caps a serverless function's request body at
 * ~4.5 MB, enforced at the platform edge before our handler ever runs. A
 * scanned 8821 routinely exceeds that, so /api/upload/pdf returned a plain
 * text 413 ("Request Entity Too Large") that never reached our code — the
 * processor just saw a JSON parse error and could not submit at all
 * (Robin Kim, loan 18063, 2026-07-22). The storage bucket itself allows
 * 50 MB, so the only real ceiling was the function body.
 *
 * Flow:
 *   1. client POSTs { files: [{ name, size }] }
 *   2. this route returns [{ path, token }] per file
 *   3. client uploads each file to storage with uploadToSignedUrl()
 *   4. client POSTs /api/upload/pdf with `uploaded_paths` instead of `files`
 *
 * Paths are server-assigned (client-supplied names are only sanitized for
 * the filename segment) so a caller can't write outside its own client
 * prefix.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

/** Matches the `uploads` bucket's configured file_size_limit. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 20;

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const admin = createAdminClient();
    const { data: profile } = await admin
      .from('profiles')
      .select('client_id, role')
      .eq('id', user.id)
      .single() as { data: { client_id: string | null; role: string } | null };

    if (!profile?.client_id) {
      return NextResponse.json({ error: 'No client associated' }, { status: 400 });
    }

    const body = await request.json().catch(() => null) as
      | { files?: Array<{ name?: unknown; size?: unknown }> }
      | null;
    const files = Array.isArray(body?.files) ? body!.files! : [];

    if (files.length === 0) {
      return NextResponse.json({ error: 'No files described' }, { status: 400 });
    }
    if (files.length > MAX_FILES) {
      return NextResponse.json({ error: `Too many files (max ${MAX_FILES})` }, { status: 400 });
    }

    const oversized = files.find(
      (f) => typeof f.size === 'number' && f.size > MAX_FILE_BYTES,
    );
    if (oversized) {
      return NextResponse.json(
        { error: `"${String(oversized.name)}" is larger than the 50 MB limit.` },
        { status: 400 },
      );
    }

    const stamp = Date.now();
    const signed: Array<{ path: string; token: string; name: string }> = [];

    for (const [i, f] of files.entries()) {
      // Server-assigned path. Only the basename comes from the client, and it
      // is stripped to a safe charset — no traversal, no cross-client writes.
      const raw = typeof f.name === 'string' ? f.name : 'upload.pdf';
      const safeName = raw.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80) || 'upload.pdf';
      const path = `${profile.client_id}/8821/${stamp}-${i}-${safeName}`;

      const { data, error } = await admin.storage
        .from('uploads')
        .createSignedUploadUrl(path);

      if (error || !data) {
        console.error('[sign-8821] createSignedUploadUrl failed:', error);
        return NextResponse.json(
          { error: 'Could not prepare the upload. Please try again.' },
          { status: 500 },
        );
      }

      signed.push({ path: data.path, token: data.token, name: raw });
    }

    return NextResponse.json({ uploads: signed });
  } catch (err) {
    console.error('[sign-8821] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
