import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import JSZip from 'jszip';

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const requestId = request.nextUrl.searchParams.get('requestId');
    if (!requestId) {
      return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, client_id')
      .eq('id', user.id)
      .single();

    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 403 });
    }

    const adminSupabase = createAdminClient();

    // Get the request and verify access
    const { data: req } = await adminSupabase
      .from('requests')
      .select('id, client_id, loan_number')
      .eq('id', requestId)
      .single();

    if (!req) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    }

    // Check access
    if (profile.role !== 'admin' && profile.role !== 'expert') {
      if (req.client_id !== profile.client_id) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
      }
    }

    // Get all entities with transcript URLs
    const { data: entities } = await adminSupabase
      .from('request_entities')
      .select('id, entity_name, transcript_urls, signed_8821_url')
      .eq('request_id', requestId) as { data: any[] | null; error: any };

    if (!entities || entities.length === 0) {
      return NextResponse.json({ error: 'No entities found' }, { status: 404 });
    }

    const zip = new JSZip();
    let fileCount = 0;

    for (const entity of entities) {
      const entityFolder = zip.folder(entity.entity_name || entity.id);
      if (!entityFolder) continue;

      // Add signed 8821 if present
      if (entity.signed_8821_url) {
        try {
          const { data: fileData } = await adminSupabase.storage
            .from('uploads')
            .download(entity.signed_8821_url);

          if (fileData) {
            const buffer = Buffer.from(await fileData.arrayBuffer());
            entityFolder.file('Signed-8821.pdf', buffer);
            fileCount++;
          }
        } catch {
          // Skip failed downloads
        }
      }

      // Add transcripts
      if (entity.transcript_urls && entity.transcript_urls.length > 0) {
        for (const url of entity.transcript_urls) {
          try {
            const { data: fileData } = await adminSupabase.storage
              .from('uploads')
              .download(url);

            if (fileData) {
              const buffer = Buffer.from(await fileData.arrayBuffer());
              // Extract clean filename from storage path
              const rawName = url.split('/').pop() || `transcript-${fileCount}.pdf`;
              const cleanName = rawName.replace(/^\d+-/, ''); // Remove timestamp prefix
              entityFolder.file(cleanName, buffer);
              fileCount++;
            }
          } catch {
            // Skip failed downloads
          }
        }
      }
    }

    if (fileCount === 0) {
      return NextResponse.json({ error: 'No files to download' }, { status: 404 });
    }

    const zipBuffer = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });

    return new NextResponse(zipBuffer as ArrayBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${(req.loan_number || requestId).replace(/[^a-zA-Z0-9 ]/g, '')}-transcripts.zip"`,
      },
    });
  } catch (error) {
    console.error('Download all transcripts error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
