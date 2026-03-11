import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { sendExpertCompletionNotification } from '@/lib/sendgrid';

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
      .select('role, full_name')
      .eq('id', user.id)
      .single();

    if (!profile || profile.role !== 'expert') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const formData = await request.formData();
    const assignmentId = formData.get('assignmentId') as string | null;
    const entityId = formData.get('entityId') as string | null;

    if (!assignmentId || !entityId) {
      return NextResponse.json(
        { error: 'assignmentId and entityId are required' },
        { status: 400 }
      );
    }

    // Get all uploaded files
    const files: File[] = [];
    for (const [key, value] of formData.entries()) {
      if (key === 'files' && value instanceof File) {
        files.push(value);
      }
    }

    if (files.length === 0) {
      return NextResponse.json({ error: 'No files uploaded' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // Verify the expert owns this assignment
    const { data: assignment } = await adminSupabase
      .from('expert_assignments')
      .select('id, expert_id, status, entity_id, sla_deadline')
      .eq('id', assignmentId)
      .single();

    if (!assignment) {
      return NextResponse.json({ error: 'Assignment not found' }, { status: 404 });
    }

    if (assignment.expert_id !== user.id) {
      return NextResponse.json({ error: 'Not your assignment' }, { status: 403 });
    }

    if (assignment.entity_id !== entityId) {
      return NextResponse.json({ error: 'Entity mismatch' }, { status: 400 });
    }

    if (!['assigned', 'in_progress'].includes(assignment.status)) {
      return NextResponse.json(
        { error: 'Assignment is not active' },
        { status: 400 }
      );
    }

    // Get existing entity data
    const { data: entity } = await adminSupabase
      .from('request_entities')
      .select('id, entity_name, transcript_urls, request_id')
      .eq('id', entityId)
      .single();

    if (!entity) {
      return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
    }

    // Upload transcript files
    const uploadedUrls: string[] = [];
    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const filePath = `transcripts/${entityId}/${Date.now()}-${file.name}`;

      const contentType = file.name.endsWith('.html') ? 'text/html' : 'application/pdf';

      const { error: uploadError } = await adminSupabase.storage
        .from('uploads')
        .upload(filePath, buffer, {
          contentType,
          upsert: false,
        });

      if (uploadError) {
        console.error('Transcript upload error:', uploadError);
        continue;
      }

      uploadedUrls.push(filePath);
    }

    if (uploadedUrls.length === 0) {
      return NextResponse.json({ error: 'All file uploads failed' }, { status: 500 });
    }

    // Update entity transcript_urls (append to existing)
    const existingUrls = entity.transcript_urls || [];
    const allUrls = [...existingUrls, ...uploadedUrls];

    await adminSupabase
      .from('request_entities')
      .update({
        transcript_urls: allUrls,
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', entityId);

    // Update assignment as completed
    const completedAt = new Date();
    const slaMet = completedAt <= new Date(assignment.sla_deadline);

    await adminSupabase
      .from('expert_assignments')
      .update({
        status: 'completed',
        completed_at: completedAt.toISOString(),
        sla_met: slaMet,
      })
      .eq('id', assignmentId);

    // Check if all entities in the request are completed
    const { data: requestEntities } = await adminSupabase
      .from('request_entities')
      .select('id, status')
      .eq('request_id', entity.request_id);

    const allCompleted = requestEntities?.every((e) => e.status === 'completed');

    if (allCompleted) {
      await adminSupabase
        .from('requests')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
        })
        .eq('id', entity.request_id);
    }

    // Audit log
    await logAuditFromRequest(adminSupabase, request, {
      action: 'expert_transcript_uploaded',
      userId: user.id,
      userEmail: user.email || '',
      resourceType: 'request_entity',
      resourceId: entityId,
      details: {
        assignment_id: assignmentId,
        file_count: uploadedUrls.length,
        sla_met: slaMet,
        transcript_urls: uploadedUrls,
        request_id: entity.request_id,
      },
    });

    // Notify admin users
    try {
      const { data: admins } = await adminSupabase
        .from('profiles')
        .select('email')
        .eq('role', 'admin');

      if (admins) {
        for (const admin of admins) {
          await sendExpertCompletionNotification(
            admin.email,
            profile.full_name || user.email || 'Expert',
            entity.entity_name,
            entity.request_id
          );
        }
      }
    } catch (emailError) {
      console.error('Failed to send completion notifications:', emailError);
    }

    return NextResponse.json({
      success: true,
      uploaded_count: uploadedUrls.length,
      transcript_urls: uploadedUrls,
      sla_met: slaMet,
    });
  } catch (error) {
    console.error('Transcript upload error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
