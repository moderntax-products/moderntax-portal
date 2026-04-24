import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';

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

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!profile || profile.role !== 'expert') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const entityId = request.nextUrl.searchParams.get('entityId');
    if (!entityId) {
      return NextResponse.json({ error: 'entityId is required' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // Verify the expert has an active assignment for this entity
    const { data: assignment } = await adminSupabase
      .from('expert_assignments')
      .select('id, expert_id, entity_id')
      .eq('entity_id', entityId)
      .eq('expert_id', user.id)
      .in('status', ['assigned', 'in_progress'])
      .single();

    if (!assignment) {
      return NextResponse.json(
        { error: 'No active assignment for this entity' },
        { status: 403 }
      );
    }

    // Get the entity's signed_8821_url
    const { data: entity } = await adminSupabase
      .from('request_entities')
      .select('signed_8821_url, entity_name')
      .eq('id', entityId)
      .single();

    if (!entity || !entity.signed_8821_url) {
      return NextResponse.json(
        { error: 'No signed 8821 available for this entity' },
        { status: 404 }
      );
    }

    // Generate a signed URL (valid for 1 hour)
    const { data: signedUrlData, error: signError } = await adminSupabase.storage
      .from('uploads')
      .createSignedUrl(entity.signed_8821_url, 3600);

    if (signError || !signedUrlData?.signedUrl) {
      console.error('Failed to create signed URL:', signError);
      return NextResponse.json(
        { error: 'Failed to generate download link' },
        { status: 500 }
      );
    }

    // SOC 2: log signed 8821 downloads — these contain SSN, signature, and
    // taxpayer identity data.
    try {
      await logAuditFromRequest(adminSupabase, request, {
        action: 'transcript_downloaded',
        userId: user.id,
        userEmail: user.email || '',
        resourceType: 'request_entity',
        resourceId: entityId,
        details: {
          file_kind: 'signed_8821',
          file_path: entity.signed_8821_url,
          entity_name: entity.entity_name,
          assignment_id: assignment.id,
          role: 'expert',
          signed_url_ttl_seconds: 3600,
        },
      });
    } catch (auditErr) {
      console.error('[download-8821] audit log failed:', auditErr);
    }

    return NextResponse.json({
      url: signedUrlData.signedUrl,
      entityName: entity.entity_name,
    });
  } catch (error) {
    console.error('Download 8821 error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
