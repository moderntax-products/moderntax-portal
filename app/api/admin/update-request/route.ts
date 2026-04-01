import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { sendStatusChangeNotification } from '@/lib/sendgrid';
import { triggerWebhookForRequest, triggerErrorWebhookForRequest } from '@/lib/webhook';

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    // Verify the caller is an admin
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { data: callerProfile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!callerProfile || callerProfile.role !== 'admin') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const body = await request.json();
    const { action } = body;

    const adminSupabase = createAdminClient();

    switch (action) {
      case 'update_request_status': {
        const { requestId, status, notes } = body;
        if (!requestId || !status) {
          return NextResponse.json({ error: 'Missing requestId or status' }, { status: 400 });
        }

        const validStatuses = ['submitted', '8821_sent', '8821_signed', 'irs_queue', 'processing', 'completed', 'failed'];
        if (!validStatuses.includes(status)) {
          return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
        }

        // Fetch current request to get old status and requesting user
        const { data: currentRequest } = await adminSupabase
          .from('requests')
          .select('status, loan_number, requested_by, profiles:requested_by(email)')
          .eq('id', requestId)
          .single() as { data: any; error: any };

        const oldStatus = currentRequest?.status || 'unknown';

        const updateData: Record<string, unknown> = { status };
        if (status === 'completed') {
          updateData.completed_at = new Date().toISOString();
        }
        if (notes !== undefined) {
          updateData.notes = notes;
        }

        const { error: updateError } = await adminSupabase
          .from('requests')
          .update(updateData)
          .eq('id', requestId);

        if (updateError) {
          return NextResponse.json({ error: updateError.message }, { status: 500 });
        }

        await logAuditFromRequest(adminSupabase, request, {
          action: 'request_created',
          userId: user.id,
          userEmail: user.email || '',
          resourceType: 'request',
          resourceId: requestId,
          details: { admin_action: 'status_update', new_status: status, old_status: oldStatus, notes },
        });

        // Request-level status changes don't email processors
        // Processors only get notified on entity-level 8821_signed and completed transitions

        // Trigger webhook for API-intake requests on terminal statuses
        if (status === 'completed' || status === 'failed') {
          try {
            if (status === 'completed') {
              await triggerWebhookForRequest(adminSupabase, requestId);
            } else {
              await triggerErrorWebhookForRequest(
                adminSupabase,
                requestId,
                notes || 'Request marked as failed by admin.'
              );
            }
          } catch (webhookErr) {
            console.error(`[admin-update] Webhook trigger failed for ${requestId}:`, webhookErr);
          }
        }

        return NextResponse.json({ success: true });
      }

      case 'update_entity_status': {
        const { entityId, status } = body;
        if (!entityId || !status) {
          return NextResponse.json({ error: 'Missing entityId or status' }, { status: 400 });
        }

        const validEntityStatuses = ['pending', 'submitted', '8821_sent', '8821_signed', 'irs_queue', 'processing', 'completed', 'failed'];
        if (!validEntityStatuses.includes(status)) {
          return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
        }

        // Fetch current entity and its request for notification context
        const { data: currentEntity } = await adminSupabase
          .from('request_entities')
          .select('status, entity_name, request_id, requests:request_id(loan_number, requested_by, profiles:requested_by(email))')
          .eq('id', entityId)
          .single() as { data: any; error: any };

        const oldEntityStatus = currentEntity?.status || 'unknown';

        const entityUpdate: Record<string, unknown> = { status };
        if (status === 'completed') {
          entityUpdate.completed_at = new Date().toISOString();
        }

        const { error: updateError } = await adminSupabase
          .from('request_entities')
          .update(entityUpdate)
          .eq('id', entityId);

        if (updateError) {
          return NextResponse.json({ error: updateError.message }, { status: 500 });
        }

        await logAuditFromRequest(adminSupabase, request, {
          action: 'request_created',
          userId: user.id,
          userEmail: user.email || '',
          resourceType: 'entity',
          resourceId: entityId,
          details: { admin_action: 'entity_status_update', new_status: status, old_status: oldEntityStatus },
        });

        // Send status change email for key entity status transitions
        // Processors only get notified on 8821_signed and completed
        const notifiableStatuses = ['8821_signed', 'completed'];
        if (notifiableStatuses.includes(status) && oldEntityStatus !== status && currentEntity?.requests?.profiles?.email) {
          try {
            await sendStatusChangeNotification(
              currentEntity.requests.profiles.email,
              currentEntity.request_id,
              currentEntity.requests.loan_number || currentEntity.request_id,
              oldEntityStatus,
              status,
              currentEntity.entity_name
            );
          } catch (emailError) {
            console.error('Failed to send entity status change email:', emailError);
          }
        }

        return NextResponse.json({ success: true });
      }

      case 'update_entity_transcripts': {
        const { entityId, transcriptUrls, complianceScore } = body;
        if (!entityId) {
          return NextResponse.json({ error: 'Missing entityId' }, { status: 400 });
        }

        const entityUpdate: Record<string, unknown> = {};
        if (transcriptUrls !== undefined) {
          entityUpdate.transcript_urls = transcriptUrls;
        }
        if (complianceScore !== undefined) {
          entityUpdate.compliance_score = complianceScore;
        }

        const { error: updateError } = await adminSupabase
          .from('request_entities')
          .update(entityUpdate)
          .eq('id', entityId);

        if (updateError) {
          return NextResponse.json({ error: updateError.message }, { status: 500 });
        }

        await logAuditFromRequest(adminSupabase, request, {
          action: 'file_uploaded',
          userId: user.id,
          userEmail: user.email || '',
          resourceType: 'entity',
          resourceId: entityId,
          details: {
            admin_action: 'transcript_update',
            transcript_count: transcriptUrls?.length || 0,
            compliance_score: complianceScore,
          },
        });

        return NextResponse.json({ success: true });
      }

      case 'update_request_notes': {
        const { requestId, notes } = body;
        if (!requestId) {
          return NextResponse.json({ error: 'Missing requestId' }, { status: 400 });
        }

        const { error: updateError } = await adminSupabase
          .from('requests')
          .update({ notes })
          .eq('id', requestId);

        if (updateError) {
          return NextResponse.json({ error: updateError.message }, { status: 500 });
        }

        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('Admin update error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
