/**
 * POST /api/manager/convert-8821/extract
 *
 * Manager-only endpoint. Accepts a signed 8821 PDF from any vendor
 * (Tax Guard, Wolters Kluwer, Avantax, etc.) and returns the extracted
 * structured data via Claude vision. Caller (the UI) shows the result
 * pre-filled in an editable form, then POSTs to .../generate to
 * produce the new ModernTax-designated 8821.
 *
 * Body: multipart/form-data
 *   - file: PDF
 *
 * Returns: { extracted: ExtractedTaxpayer, sourcePdfPath?: string }
 *   sourcePdfPath is the temporary supabase storage path so the UI can
 *   render the original PDF side-by-side with the extracted form.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { extract8821WithVision } from '@/lib/extract-8821-vision';

export const runtime = 'nodejs';
export const maxDuration = 30; // vision call typically 5-10s, leave headroom

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles').select('role, client_id').eq('id', user.id).single() as { data: any };
  if (!profile || !['manager', 'processor', 'admin'].includes(profile.role)) {
    return NextResponse.json({ error: 'Manager / processor / admin only' }, { status: 403 });
  }

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  if (file.type && !file.type.includes('pdf')) {
    return NextResponse.json({ error: 'Only PDF files supported' }, { status: 400 });
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: 'PDF too large (10MB max)' }, { status: 413 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // Stash the PDF in storage so the UI preview pane can show it side-by-side
  // with the extracted form. Path is scoped by client to keep RLS happy.
  // 24-hour signed URL is enough for the conversion-flow round-trip.
  const admin = createAdminClient();
  const clientId = profile.client_id || 'orphan';
  const ts = Date.now();
  const safeName = (file.name || 'source-8821.pdf').replace(/[^\w.\-]+/g, '_');
  const storagePath = `${clientId}/convert-8821-sources/${ts}-${safeName}`;
  let sourcePdfUrl: string | null = null;
  const { error: upErr } = await admin.storage.from('uploads').upload(storagePath, buffer, {
    contentType: 'application/pdf', upsert: false,
  });
  if (!upErr) {
    const { data: signed } = await admin.storage.from('uploads').createSignedUrl(storagePath, 60 * 60 * 24);
    sourcePdfUrl = signed?.signedUrl || null;
  } else {
    console.warn('[convert-8821/extract] Source PDF upload failed (non-fatal):', upErr.message);
  }

  const extracted = await extract8821WithVision(buffer);

  return NextResponse.json({
    extracted,
    sourcePdfUrl,
    sourcePdfPath: upErr ? null : storagePath,
    filename: file.name,
  });
}
