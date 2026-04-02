import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { sendExpertIssueNotification, send8821FaxRequest } from '@/lib/sendgrid';

export async function POST(request: Request) {
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

    const body = await request.json();
    const { action, assignmentId } = body;

    if (!assignmentId) {
      return NextResponse.json({ error: 'assignmentId is required' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // Verify the expert owns this assignment
    const { data: assignment } = await adminSupabase
      .from('expert_assignments')
      .select('id, expert_id, status, entity_id')
      .eq('id', assignmentId)
      .single();

    if (!assignment) {
      return NextResponse.json({ error: 'Assignment not found' }, { status: 404 });
    }

    if (assignment.expert_id !== user.id) {
      return NextResponse.json({ error: 'Not your assignment' }, { status: 403 });
    }

    switch (action) {
      case 'start_work': {
        if (assignment.status !== 'assigned') {
          return NextResponse.json(
            { error: 'Can only start work on assigned items' },
            { status: 400 }
          );
        }

        await adminSupabase
          .from('expert_assignments')
          .update({ status: 'in_progress' })
          .eq('id', assignmentId);

        await logAuditFromRequest(adminSupabase, request, {
          action: 'expert_assigned',
          userId: user.id,
          userEmail: user.email || '',
          resourceType: 'expert_assignment',
          resourceId: assignmentId,
          details: { status_change: 'in_progress' },
        });

        return NextResponse.json({ success: true, status: 'in_progress' });
      }

      case 'flag_issue': {
        const { missReason, notes, markFailed } = body;

        const updateData: Record<string, unknown> = {
          miss_reason: missReason || null,
          expert_notes: notes || null,
        };

        if (markFailed) {
          updateData.status = 'failed';
          updateData.completed_at = new Date().toISOString();
          updateData.sla_met = false;
        }

        await adminSupabase
          .from('expert_assignments')
          .update(updateData)
          .eq('id', assignmentId);

        await logAuditFromRequest(adminSupabase, request, {
          action: 'expert_issue_flagged',
          userId: user.id,
          userEmail: user.email || '',
          resourceType: 'expert_assignment',
          resourceId: assignmentId,
          details: {
            miss_reason: missReason,
            notes,
            marked_failed: !!markFailed,
            entity_id: assignment.entity_id,
          },
        });

        // If marked as failed, update entity status
        if (markFailed) {
          await adminSupabase
            .from('request_entities')
            .update({ status: 'failed' })
            .eq('id', assignment.entity_id);
        }

        // Notify admin users about the flagged issue
        let entityData: { entity_name: string; request_id: string; signer_email: string | null; signer_first_name: string | null; signer_last_name: string | null; form_type: string; signed_8821_url: string | null } | null = null;
        try {
          const { data: entity } = await adminSupabase
            .from('request_entities')
            .select('entity_name, request_id, signer_email, signer_first_name, signer_last_name, form_type, signed_8821_url')
            .eq('id', assignment.entity_id)
            .single();

          entityData = entity;

          const { data: admins } = await adminSupabase
            .from('profiles')
            .select('email')
            .eq('role', 'admin');

          if (admins && entity) {
            for (const admin of admins) {
              await sendExpertIssueNotification(
                admin.email,
                user.email || 'Expert',
                entity.entity_name,
                missReason || 'Issue flagged',
                notes || null,
                entity.request_id
              );
            }
          }
        } catch (emailError) {
          console.error('Failed to send expert issue notification:', emailError);
        }

        // Auto-send fax-back 8821 email when IRS rejects digital signature
        let faxEmailSent = false;
        if (missReason === 'irs_rejected' && entityData?.signer_email) {
          try {
            const signerName = [entityData.signer_first_name, entityData.signer_last_name]
              .filter(Boolean)
              .join(' ') || entityData.entity_name;

            // Generate a download URL for the signed 8821 if available
            let downloadUrl: string | null = null;
            if (entityData.signed_8821_url) {
              const { data: signedUrl } = await adminSupabase.storage
                .from('documents')
                .createSignedUrl(entityData.signed_8821_url, 60 * 60 * 24 * 7); // 7 day expiry
              downloadUrl = signedUrl?.signedUrl || null;
            }

            await send8821FaxRequest(
              entityData.signer_email,
              signerName,
              entityData.entity_name,
              entityData.form_type,
              entityData.request_id,
              downloadUrl
            );

            faxEmailSent = true;

            // Revert entity status to pending so it re-enters the 8821 flow
            // once the wet-signed fax is received and uploaded
            await adminSupabase
              .from('request_entities')
              .update({
                status: 'pending',
                signed_8821_url: null,
                signature_id: null,
                signature_created_at: null,
              })
              .eq('id', assignment.entity_id);

            await logAuditFromRequest(adminSupabase, request, {
              action: 'irs_rejected_auto_fax_email',
              userId: user.id,
              userEmail: user.email || '',
              resourceType: 'request_entity',
              resourceId: assignment.entity_id,
              details: {
                signer_email: entityData.signer_email,
                entity_name: entityData.entity_name,
                fax_email_sent: true,
              },
            });

            console.log(`[IRS Rejected] Auto fax-back email sent to ${entityData.signer_email} for entity ${entityData.entity_name}`);
          } catch (faxEmailError) {
            console.error('Failed to send 8821 fax request email:', faxEmailError);
          }
        }

        return NextResponse.json({ success: true, marked_failed: !!markFailed, fax_email_sent: faxEmailSent });
      }

      case 'add_notes': {
        const { notes } = body;

        await adminSupabase
          .from('expert_assignments')
          .update({ expert_notes: notes || null })
          .eq('id', assignmentId);

        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('Expert status update error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
