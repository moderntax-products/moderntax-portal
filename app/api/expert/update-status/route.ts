import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { sendExpertIssueNotification, send8821FaxRequest, sendProcessorActionNeededNudge } from '@/lib/sendgrid';

// Flag reasons where the SUBMITTING PROCESSOR (not just admin) is notified
// immediately to obtain a corrected, legible 8821 — the EIN/SSN is wrong or
// handwritten/illegible with no supporting evidence. These remain billable
// (taxpayer-data error). Every other reason notifies admin only, as before.
const PROCESSOR_NOTIFY_REASONS: Record<string, string> = {
  wrong_ein: 'The EIN on the 8821 is incorrect.',
  wrong_ssn: 'The SSN on the 8821 is incorrect.',
  illegible_tid: 'The EIN/SSN on the 8821 is handwritten or illegible, with no supporting evidence to verify it.',
};

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

        // 8821 rejection reasons that require resubmission
        const RESUBMISSION_REASONS = [
          'bad_address', 'wrong_ein', 'wrong_ssn', 'illegible_tid', 'wrong_business_name',
          'wrong_taxpayer_name', 'missing_tax_years', 'wrong_form_type',
          '8821_not_on_file', 'caf_not_on_file',
        ];
        const needsResubmission = RESUBMISSION_REASONS.includes(missReason);

        const updateData: Record<string, unknown> = {
          miss_reason: missReason || null,
          expert_notes: notes || null,
          needs_resubmission: needsResubmission,
          resubmission_reason: needsResubmission ? missReason : null,
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
          if (needsResubmission) {
            // 8821 rejection: reset to pending so it re-enters the correction flow
            await adminSupabase
              .from('request_entities')
              .update({ status: 'pending' })
              .eq('id', assignment.entity_id);
          } else {
            await adminSupabase
              .from('request_entities')
              .update({ status: 'failed' })
              .eq('id', assignment.entity_id);
          }
        }

        // Notify admin users about the flagged issue
        let entityData: { id: string; entity_name: string; request_id: string; signer_email: string | null; signer_first_name: string | null; signer_last_name: string | null; form_type: string; signed_8821_url: string | null } | null = null;
        try {
          const { data: entity } = await adminSupabase
            .from('request_entities')
            .select('id, entity_name, request_id, signer_email, signer_first_name, signer_last_name, form_type, signed_8821_url')
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

        // Notify the SUBMITTING PROCESSOR immediately — ONLY for wrong /
        // handwritten-illegible EIN/SSN (no supporting evidence). They must get
        // a corrected, legible 8821. The order stays billable (their data error);
        // we deliberately do NOT credit it back. All other reasons stay admin-only.
        if (entityData && PROCESSOR_NOTIFY_REASONS[missReason]) {
          try {
            const { data: req } = await adminSupabase
              .from('requests')
              .select('loan_number, requested_by')
              .eq('id', entityData.request_id)
              .single() as { data: { loan_number: string | null; requested_by: string | null } | null };
            if (req?.requested_by) {
              const { data: proc } = await adminSupabase
                .from('profiles')
                .select('email, full_name, role')
                .eq('id', req.requested_by)
                .single() as { data: { email: string | null; full_name: string | null; role: string } | null };
              if (proc?.email && ['processor', 'manager'].includes(proc.role)) {
                // 1. Put the actual detail IN-PORTAL (behind login) as a support
                //    note the processor sees on the entity — never in email.
                const { data: noteAuthor } = await adminSupabase
                  .from('profiles').select('id').eq('role', 'admin')
                  .order('created_at', { ascending: true }).limit(1).maybeSingle() as { data: { id: string } | null };
                if (noteAuthor) {
                  await (adminSupabase.from('entity_notes' as any) as any).insert({
                    entity_id: assignment.entity_id,
                    author_id: noteAuthor.id,
                    author_role: 'admin',
                    author_name: 'ModernTax Support',
                    body: `Correction needed before we can process this 8821: ${PROCESSOR_NOTIFY_REASONS[missReason]} The taxpayer's EIN/SSN must be typed and legible on the form (only the signature may be handwritten). Please obtain a corrected 8821 and re-upload it for this loan.`,
                    kind: 'support',
                  });
                }
                // 2. Email a PII-FREE nudge — no entity/loan/taxpayer detail; just
                //    "log in." The detail above is gated behind their login (+ 2FA).
                await sendProcessorActionNeededNudge(proc.email, proc.full_name || 'there');
                // Intentionally billable (processor data error) — no credit-back.
                // Traceability comes from the expert_issue_flagged audit above.
                console.log(`[update-status] Processor ${proc.email} nudged (PII-free) for ${missReason} on entity ${assignment.entity_id?.slice(0, 8)} — billable, not credited`);
              }
            }
          } catch (procNotifyErr) {
            console.error('Failed to notify processor of TID correction:', procNotifyErr);
          }
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
              // SOC 2 C1.1 — 1-hour TTL on 8821 signed URLs in outbound
              // email. Was previously 7 days; a forwarded/cached email gave
              // a week-long window into a PDF containing the taxpayer's
              // full SSN + signature. If the expert needs a longer-lived
              // link, they should re-fetch via /api/expert/download-8821
              // which issues fresh 1-hour URLs on demand.
              const { data: signedUrl } = await adminSupabase.storage
                .from('documents')
                .createSignedUrl(entityData.signed_8821_url, 60 * 60); // 1 hour
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

            console.log(`[IRS Rejected] Auto fax-back email sent for entity ${entityData.entity_name} (${entityData.id?.slice(0, 8) || '?'})`);
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
