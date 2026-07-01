/**
 * POST /api/upload/8821-presign
 *
 * Mints a short-lived signed upload URL so the browser can upload a pre-signed
 * 8821 PDF DIRECTLY to Supabase Storage, bypassing the serverless
 * request-body limit (~4.5MB). Centerstone's flat-rate flow attaches scanned
 * 8821s that are ~4MB each; sending them inline through /api/upload/csv would
 * 413 the whole multipart request. The client uploads each file to the
 * returned path, then passes only the paths to /api/upload/csv, which
 * downloads them server-side for the existing vision-match + attach flow.
 *
 * Body: { filename?: string }
 * Returns: { path, token } — use supabase.storage.from('uploads')
 *          .uploadToSignedUrl(path, token, file) on the client.
 *
 * Auth: any logged-in user with a client_id. The path is namespaced to the
 * caller's client_id, and /api/upload/csv only accepts paths under the
 * caller's own `${client_id}/8821-inbound/` prefix.
 *
 * Matt 2026-07-01.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const sb = createServerRouteClient(cookieStore);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile } = await sb
      .from('profiles').select('client_id').eq('id', user.id).single() as { data: { client_id: string | null } | null };
    if (!profile?.client_id) return NextResponse.json({ error: 'No client associated' }, { status: 400 });

    const body = (await request.json().catch(() => null)) as { filename?: string } | null;
    const raw = (body?.filename || 'signed-8821.pdf').trim();
    // Keep only safe filename chars; cap length; always land on a .pdf name.
    let safe = raw.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/_{2,}/g, '_').slice(-120);
    if (!safe || safe === '.pdf') safe = 'signed-8821.pdf';
    if (!/\.pdf$/i.test(safe)) safe = `${safe}.pdf`;

    const rand = Math.random().toString(36).slice(2, 8);
    const path = `${profile.client_id}/8821-inbound/${Date.now()}-${rand}-${safe}`;

    const admin = createAdminClient();
    const { data, error } = await admin.storage.from('uploads').createSignedUploadUrl(path);
    if (error || !data) {
      console.error('[8821-presign] createSignedUploadUrl failed:', error?.message);
      return NextResponse.json({ error: 'Could not prepare the upload. Please try again.' }, { status: 500 });
    }

    return NextResponse.json({ path: data.path, token: data.token });
  } catch (err: any) {
    console.error('[8821-presign] error:', err?.message || err);
    return NextResponse.json({ error: 'Could not prepare the upload. Please try again.' }, { status: 500 });
  }
}
