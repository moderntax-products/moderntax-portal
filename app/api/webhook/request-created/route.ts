import { createAdminClient } from '@/lib/supabase-server';
import { sendAdminNewRequestNotification } from '@/lib/sendgrid';
import { logAuditFromRequest } from '@/lib/audit';
import { sendSignatureRequest } from '@/lib/dropbox-sign';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { requestId, userId } = body;

    if (!requestId || !userId) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    const supabase = createAdminClient();

    // Fetch request details
    const { data: requestData, error: requestError } = await supabase
      .from('requests')
      .select('*')
      .eq('id', requestId)
      .single() as { data: any; error: any };

    if (requestError || !requestData) {
      return NextResponse.json(
        { error: 'Request not found' },
        { status: 404 }
      );
    }

    // Fetch user email
    const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(userId);

    if (userError || !user || !user.email) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    // Notify all admins about the new request so they can review and assign to expert
    try {
      const { data: submitterProfile } = await supabase
        .from('profiles')
        .select('role, client_id, full_name')
        .eq('id', userId)
        .single() as { data: any; error: any };

      // Get client name
      let clientName = 'Unknown';
      if (submitterProfile?.client_id) {
        const { data: clientData } = await supabase
          .from('clients')
          .select('name')
          .eq('id', submitterProfile.client_id)
          .single() as { data: any; error: any };
        clientName = clientData?.name || 'Unknown';
      }

      // Get entity count
      const { data: entityList } = await supabase
        .from('request_entities')
        .select('id')
        .eq('request_id', requestId) as { data: any[] | null; error: any };

      // Get all admin users
      const { data: admins } = await supabase
        .from('profiles')
        .select('email')
        .eq('role', 'admin');

      if (admins && admins.length > 0) {
        // Send admin notifications in parallel to avoid serial SendGrid latency
        await Promise.all(
          admins.map((admin: any) =>
            sendAdminNewRequestNotification(
              admin.email,
              submitterProfile?.full_name || user.email || 'Team Member',
              submitterProfile?.role || 'processor',
              clientName,
              requestData.loan_number || requestId,
              entityList?.length || 0,
              requestId
            ).catch((err: any) => console.error(`[request-created] Admin email to ${admin.email} failed:`, err))
          )
        );
      }
    } catch (adminEmailError) {
      console.error('Failed to send admin notification:', adminEmailError);
      // Don't fail the webhook if admin notification fails
    }

    // Auto-send 8821 via Dropbox Sign for each entity with a signer email
    try {
      const { data: entities } = await supabase
        .from('request_entities')
        .select('id, entity_name, form_type, signer_first_name, signer_last_name, signer_email, status')
        .eq('request_id', requestId) as { data: any[] | null; error: any };

      if (entities && entities.length > 0) {
        for (const entity of entities) {
          // Skip employment entities (W2_INCOME) — they don't need 8821
          if (entity.form_type === 'W2_INCOME') continue;
          // Skip entities already sent or signed
          if (['8821_sent', '8821_signed', 'irs_queue', 'processing', 'completed'].includes(entity.status)) continue;
          // Must have signer email
          if (!entity.signer_email) {
            console.log(`[request-created] Skipping 8821 for ${entity.entity_name}: no signer email`);
            continue;
          }

          try {
            const { signatureRequestId } = await sendSignatureRequest(entity, entity.signer_email);

            // Store signature_request_id and update status
            await supabase
              .from('request_entities')
              .update({
                signature_id: signatureRequestId,
                status: '8821_sent',
              })
              .eq('id', entity.id);

            console.log(`[request-created] 8821 sent for ${entity.entity_name} → ${entity.signer_email} (sig: ${signatureRequestId})`);
          } catch (sendError) {
            console.error(`[request-created] Failed to send 8821 for ${entity.entity_name}:`, sendError);
          }
        }

        // Update request status to 8821_sent if all entities are sent
        const { data: updatedEntities } = await supabase
          .from('request_entities')
          .select('status')
          .eq('request_id', requestId) as { data: any[] | null; error: any };

        if (updatedEntities) {
          const allSent = updatedEntities.every(
            (e: any) => ['8821_sent', '8821_signed', 'irs_queue', 'processing', 'completed'].includes(e.status) || e.form_type === 'W2_INCOME'
          );
          if (allSent) {
            await supabase.from('requests').update({ status: '8821_sent' }).eq('id', requestId);
          }
        }
      }
    } catch (signError) {
      console.error('[request-created] 8821 auto-send error:', signError);
    }

    // Audit log: request confirmation sent
    await logAuditFromRequest(supabase, request, {
      action: 'request_created',
      resourceType: 'request',
      resourceId: requestId,
      details: {
        webhook_action: 'confirmation_email_sent',
        recipient: user.email,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
