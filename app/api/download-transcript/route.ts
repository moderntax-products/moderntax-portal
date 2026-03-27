import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const filePath = request.nextUrl.searchParams.get('path');
    if (!filePath) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 });
    }

    // Verify the user has access to the entity that owns this transcript
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, client_id')
      .eq('id', user.id)
      .single();

    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 403 });
    }

    // Extract entity ID from the path (format: transcripts/{entityId}/... or 8821/{entityId}/...)
    const pathParts = filePath.split('/');
    if (pathParts.length < 2 || !['transcripts', '8821'].includes(pathParts[0])) {
      return NextResponse.json({ error: 'Invalid file path' }, { status: 400 });
    }
    const entityId = pathParts[1];
    const isSignedDoc = pathParts[0] === '8821';

    const adminSupabase = createAdminClient();

    // Get the entity and its request to verify access
    const { data: entity } = await adminSupabase
      .from('request_entities')
      .select('id, request_id')
      .eq('id', entityId)
      .single();

    if (!entity) {
      return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
    }

    // Admins can access everything
    if (profile.role !== 'admin') {
      // Experts can access entities they're assigned to
      if (profile.role === 'expert') {
        const { data: assignment } = await adminSupabase
          .from('expert_assignments')
          .select('id')
          .eq('entity_id', entityId)
          .eq('expert_id', user.id)
          .limit(1)
          .single();

        if (!assignment) {
          return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
        }
      } else {
        // Processors/managers can access their client's entities
        const { data: req } = await adminSupabase
          .from('requests')
          .select('client_id')
          .eq('id', entity.request_id)
          .single();

        if (!req || req.client_id !== profile.client_id) {
          return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
        }
      }
    }

    // Verify file path belongs to this entity
    const { data: entityData } = await adminSupabase
      .from('request_entities')
      .select('transcript_urls, signed_8821_url')
      .eq('id', entityId)
      .single();

    if (!entityData) {
      return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
    }

    // Check if path matches signed 8821 or transcript URLs
    const isValidPath = isSignedDoc
      ? entityData.signed_8821_url === filePath
      : entityData.transcript_urls?.includes(filePath);

    if (!isValidPath) {
      return NextResponse.json({ error: 'File not found for this entity' }, { status: 404 });
    }

    // Generate a signed URL (valid for 1 hour)
    const { data: signedUrlData, error: signError } = await adminSupabase.storage
      .from('uploads')
      .createSignedUrl(filePath, 3600);

    if (signError || !signedUrlData?.signedUrl) {
      console.error('Failed to create signed URL:', signError);
      return NextResponse.json(
        { error: 'Failed to generate download link' },
        { status: 500 }
      );
    }

    return NextResponse.json({ url: signedUrlData.signedUrl });
  } catch (error) {
    console.error('Transcript download error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
