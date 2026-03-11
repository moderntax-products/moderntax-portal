import { createAdminClient } from '@/lib/supabase-server';
import { sendRequestConfirmation, sendManagerNewRequestNotification } from '@/lib/sendgrid';
import { logAuditFromRequest } from '@/lib/audit';
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

    // Send confirmation email to requesting user
    await sendRequestConfirmation(user.email, requestData);

    // Notify managers at the same client when a processor submits a request
    try {
      const { data: processorProfile } = await supabase
        .from('profiles')
        .select('role, client_id, full_name')
        .eq('id', userId)
        .single() as { data: any; error: any };

      if (processorProfile?.client_id && processorProfile.role === 'processor') {
        const { data: managers } = await supabase
          .from('profiles')
          .select('email')
          .eq('client_id', processorProfile.client_id)
          .eq('role', 'manager');

        // Fetch entity count
        const { data: entities } = await supabase
          .from('request_entities')
          .select('id')
          .eq('request_id', requestId) as { data: any[] | null; error: any };

        if (managers && managers.length > 0) {
          for (const manager of managers) {
            await sendManagerNewRequestNotification(
              manager.email,
              processorProfile.full_name || user.email || 'Team Member',
              requestData.loan_number || requestId,
              entities?.length || 0,
              requestId
            );
          }
        }
      }
    } catch (managerEmailError) {
      console.error('Failed to send manager notification:', managerEmailError);
      // Don't fail the webhook if manager notification fails
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
