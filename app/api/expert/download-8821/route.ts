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

    // The expert is served the 8821 copy that names THEIR CAF as a designee —
    // serving a wrong-designee form (the processor's e-signed original, or
    // another expert's copy) made Joel reject work + miss an IRS callback
    // (2026-06-03). Prefer the admin-posted expert copy; otherwise AUTO-RECOGNIZE
    // a signed_8821_url whose designee matches THIS expert's CAF (the Clearfirm
    // auto-flow lands the expert-credentialed form there), and cache the approval
    // so we don't re-parse on every download.
    const { data: entity } = await (adminSupabase
      .from('request_entities') as any)
      .select('admin_uploaded_8821_url, signed_8821_url, entity_name')
      .eq('id', entityId)
      .single() as { data: { admin_uploaded_8821_url: string | null; signed_8821_url: string | null; entity_name: string } | null };

    if (!entity) {
      return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
    }

    let downloadPath = entity.admin_uploaded_8821_url;

    if (!downloadPath && entity.signed_8821_url) {
      const { data: me } = await adminSupabase
        .from('profiles').select('caf_number').eq('id', user.id).maybeSingle() as { data: { caf_number: string | null } | null };
      if (me?.caf_number) {
        try {
          const dl = await adminSupabase.storage.from('uploads').download(entity.signed_8821_url);
          if (dl.data) {
            const { verify8821Designee } = await import('@/lib/verify-8821-designee');
            const check = await verify8821Designee(Buffer.from(await dl.data.arrayBuffer()), me.caf_number);
            if (check.ok) {
              downloadPath = entity.signed_8821_url;
              await (adminSupabase.from('request_entities') as any)
                .update({ admin_uploaded_8821_url: entity.signed_8821_url }).eq('id', entityId);
            }
          }
        } catch (e) { console.error('[download-8821] auto-recognize failed:', e); }
      }
    }

    if (!downloadPath) {
      return NextResponse.json(
        {
          error: 'Your 8821 is being prepared by an admin and isn’t ready to download yet. It will appear here once the expert copy with your designee credentials is posted.',
          code: 'admin_8821_pending',
        },
        { status: 409 }
      );
    }

    // Generate a signed URL (valid for 1 hour)
    const { data: signedUrlData, error: signError } = await adminSupabase.storage
      .from('uploads')
      .createSignedUrl(downloadPath, 3600);

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
          file_path: downloadPath,
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
