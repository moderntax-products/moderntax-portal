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
      .select('role')
      .eq('id', user.id)
      .single();

    if (!profile || profile.role !== 'admin') {
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
      .select('id, entity_name, request_id')
      .eq('id', entityId)
      .single();

    if (!entity) {
      return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
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

    // Update entity with signed_8821_url
    const { error: updateError } = await adminSupabase
      .from('request_entities')
      .update({ signed_8821_url: filePath })
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
