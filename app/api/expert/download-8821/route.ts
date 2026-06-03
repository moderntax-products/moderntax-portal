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

    // Experts download ONLY the admin-prepared 8821 (admin_uploaded_8821_url) —
    // the copy an admin posts with the expert's correct designee credentials,
    // re-wet-signed (not the DocuSign-flattened processor original). Serving the
    // processor's original / an e-signed copy caused experts to reject the work
    // and skip IRS calls — Joel Abernathy missed a scheduled IRS callback this
    // way (2026-06-03). If the admin copy isn't posted yet, return a clear
    // "pending" state rather than handing over the wrong form.
    const { data: entity } = await adminSupabase
      .from('request_entities')
      .select('admin_uploaded_8821_url, entity_name')
      .eq('id', entityId)
      .single();

    if (!entity || !entity.admin_uploaded_8821_url) {
      return NextResponse.json(
        {
          error: 'Your 8821 is being prepared by an admin and isn’t ready to download yet. It will appear here once the admin posts the expert copy with your designee credentials.',
          code: 'admin_8821_pending',
        },
        { status: 409 }
      );
    }

    // Generate a signed URL (valid for 1 hour)
    const { data: signedUrlData, error: signError } = await adminSupabase.storage
      .from('uploads')
      .createSignedUrl(entity.admin_uploaded_8821_url, 3600);

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
          file_kind: 'admin_uploaded_8821',
          file_path: entity.admin_uploaded_8821_url,
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
