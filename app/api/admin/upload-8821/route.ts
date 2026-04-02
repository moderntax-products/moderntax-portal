import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';

export async function POST(request: NextRequest) {
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
      .select('role, client_id')
      .eq('id', user.id)
      .single() as { data: { role: string; client_id: string | null } | null; error: any };

    if (!profile || !['admin', 'processor', 'manager'].includes(profile.role)) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const formData = await request.formData();
    const entityId = formData.get('entityId') as string | null;
    const file = formData.get('file') as File | null;

    if (!entityId || !file) {
      return NextResponse.json(
        { error: 'entityId and file are required' },
        { status: 400 }
      );
    }

    // Validate file type
    if (!file.name.endsWith('.pdf')) {
      return NextResponse.json(
        { error: 'Only PDF files are accepted for 8821 forms' },
        { status: 400 }
      );
    }

    const adminSupabase = createAdminClient();

    // Verify entity exists
    const { data: entity } = await adminSupabase
      .from('request_entities')
      .select('id, entity_name, request_id, status')
      .eq('id', entityId)
      .single() as { data: any; error: any };

    if (!entity) {
      return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
    }

    // For non-admins, verify entity belongs to their client
    if (profile.role !== 'admin' && profile.client_id) {
      const { data: req } = await adminSupabase
        .from('requests')
        .select('client_id')
        .eq('id', entity.request_id)
        .single() as { data: any; error: any };

      if (!req || req.client_id !== profile.client_id) {
        return NextResponse.json({ error: 'Not authorized for this entity' }, { status: 403 });
      }
    }

    // Upload file to Supabase storage
    const buffer = Buffer.from(await file.arrayBuffer());
    const filePath = `8821/${entityId}/${Date.now()}-signed-8821.pdf`;

    const { error: uploadError } = await adminSupabase.storage
      .from('uploads')
      .upload(filePath, buffer, {
        contentType: 'application/pdf',
        upsert: false,
      });

    if (uploadError) {
      console.error('8821 upload error:', uploadError);
      return NextResponse.json(
        { error: 'Failed to upload file' },
        { status: 500 }
      );
    }

    // Update entity with signed_8821_url and auto-advance status
    const updateFields: Record<string, unknown> = { signed_8821_url: filePath };
    if (['pending', 'submitted', '8821_sent'].includes(entity.status)) {
      updateFields.status = '8821_signed';
    }

    const { error: updateError } = await adminSupabase
      .from('request_entities')
      .update(updateFields)
      .eq('id', entityId);

    if (updateError) {
      console.error('Failed to update entity:', updateError);
      return NextResponse.json(
        { error: 'Failed to update entity record' },
        { status: 500 }
      );
    }

    // Audit log
    await logAuditFromRequest(adminSupabase, request, {
      action: 'file_uploaded',
      userId: user.id,
      userEmail: user.email || '',
      resourceType: 'request_entity',
      resourceId: entityId,
      details: {
        action: '8821_uploaded',
        entity_name: entity.entity_name,
        file_path: filePath,
        request_id: entity.request_id,
      },
    });

    return NextResponse.json({
      success: true,
      filePath,
      entityName: entity.entity_name,
    });
  } catch (error) {
    console.error('8821 upload error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
