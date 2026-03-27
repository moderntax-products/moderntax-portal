import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { sendExpertCompletionNotification, sendCompletionNotification } from '@/lib/sendgrid';

/**
 * Expert transcript upload route.
 * Supports uploading one file at a time to avoid Vercel's 4.5MB body size limit.
 * Include `complete=true` in FormData on the final upload to complete the assignment.
 */
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
    const shouldComplete = formData.get('complete') === 'true';

    if (!assignmentId || !entityId) {
      return NextResponse.json(
        { error: 'assignmentId and entityId are required' },
        { status: 400 }
      );
    }

    // Get uploaded files (may be 0 if just completing)
    const files: File[] = [];
    for (const [key, value] of formData.entries()) {
      if (key === 'files' && value instanceof File) {
        files.push(value);
      }
    }

    if (files.length === 0 && !shouldComplete) {
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

    if (!['assigned', 'in_progress', 'completed'].includes(assignment.status)) {
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

    // Upload transcript files (if any provided)
    const uploadedUrls: string[] = [];
    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const filePath = `transcripts/${entityId}/${Date.now()}-${file.name}`;

      const contentType = file.name.endsWith('.html') || file.name.endsWith('.htm')
        ? 'text/html'
        : 'application/pdf';

      const { error: uploadError } = await adminSupabase.storage
        .from('uploads')
        .upload(filePath, buffer, {
          contentType,
          upsert: false,
        });

      if (uploadError) {
        console.error('Transcript upload error:', uploadError);
        return NextResponse.json(
          { error: `Failed to upload ${file.name}: ${uploadError.message}` },
          { status: 500 }
        );
      }

      uploadedUrls.push(filePath);
    }

    // Append new file URLs to entity transcript_urls
    if (uploadedUrls.length > 0) {
      const existingUrls = entity.transcript_urls || [];
      const allUrls = [...existingUrls, ...uploadedUrls];

      await adminSupabase
        .from('request_entities')
        .update({ transcript_urls: allUrls })
        .eq('id', entityId);
    }

    // If this is the completion call, finalize the assignment
    let slaMet: boolean | null = null;
    if (shouldComplete) {
      // Update entity status to completed
      await adminSupabase
        .from('request_entities')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
        })
        .eq('id', entityId);

      // Update assignment as completed and compute SLA
      const completedAt = new Date();
      slaMet = completedAt <= new Date(assignment.sla_deadline);

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

      // Notify the processor that transcripts are ready (if all entities completed)
      if (allCompleted) {
        try {
          const { data: requestData } = await adminSupabase
            .from('requests')
            .select('id, loan_number, requested_by, profiles!requests_requested_by_fkey(email)')
            .eq('id', entity.request_id)
            .single();

          const processorEmail = (requestData as any)?.profiles?.email;
          if (processorEmail) {
            const { data: completedEntities } = await adminSupabase
              .from('request_entities')
              .select('*')
              .eq('request_id', entity.request_id);

            if (completedEntities) {
              await sendCompletionNotification(
                processorEmail,
                requestData as any,
                completedEntities as any
              );
            }
          }
        } catch (procEmailError) {
          console.error('Failed to send processor completion notification:', procEmailError);
        }
      }
    }

    return NextResponse.json({
      success: true,
      uploaded_count: uploadedUrls.length,
      transcript_urls: uploadedUrls,
      completed: shouldComplete,
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
