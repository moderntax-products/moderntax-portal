/**
 * Webhook Handler for External Status Updates
 * Receives status updates from ModernTax backend and updates request status
 * POST /api/webhook
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendCompletionNotification, sendAdminFailureAlert } from '@/lib/sendgrid';
import { logAuditFromRequest } from '@/lib/audit';
import type { RequestStatus } from '@/lib/types';

interface WebhookPayload {
  request_id: string;
  status: RequestStatus;
  entities?: Array<{
    id: string;
    status: string;
    compliance_score?: number;
    transcript_urls?: string[];
  }>;
  reason?: string;
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createAdminClient();

    // Validate API key
    const apiKey = request.headers.get('x-api-key');
    const expectedApiKey = process.env.WEBHOOK_API_KEY;

    if (!apiKey || !expectedApiKey || apiKey !== expectedApiKey) {
      // Audit log: unauthorized webhook attempt
      await logAuditFromRequest(supabase, request, {
        action: 'login_failed',
        resourceType: 'webhook',
        details: { reason: 'Invalid API key' },
      });
      return NextResponse.json(
        { error: 'Unauthorized: Invalid API key' },
        { status: 401 }
      );
    }

    // Parse request body
    const payload: WebhookPayload = await request.json();

    // Validate required fields
    if (!payload.request_id || !payload.status) {
      return NextResponse.json(
        { error: 'Missing required fields: request_id, status' },
        { status: 400 }
      );
    }

    // Get request details
    const { data: requestData, error: fetchError } = await supabase
      .from('requests')
      .select('*, profiles:requested_by(email, full_name)')
      .eq('id', payload.request_id)
      .single() as { data: any; error: any };

    if (fetchError || !requestData) {
      console.error('Request not found:', payload.request_id);
      return NextResponse.json(
        { error: 'Request not found' },
        { status: 404 }
      );
    }

    // Update request status
    const { error: updateError } = await supabase
      .from('requests')
      .update({
        status: payload.status,
        updated_at: new Date().toISOString(),
        completed_at: payload.status === 'completed' ? new Date().toISOString() : null,
      })
      .eq('id', payload.request_id);

    if (updateError) {
      console.error('Failed to update request status:', updateError);
      return NextResponse.json(
        { error: 'Failed to update request status' },
        { status: 500 }
      );
    }

    // Update entity statuses if provided
    if (payload.entities && payload.entities.length > 0) {
      for (const entity of payload.entities) {
        const { error: entityError } = await supabase
          .from('request_entities')
          .update({
            status: entity.status,
            compliance_score: entity.compliance_score,
            transcript_urls: entity.transcript_urls,
            updated_at: new Date().toISOString(),
            completed_at:
              entity.status === 'completed' ? new Date().toISOString() : null,
          })
          .eq('id', entity.id);

        if (entityError) {
          console.error(`Failed to update entity ${entity.id}:`, entityError);
        }
      }
    }

    // Send completion email if status is completed
    if (
      payload.status === 'completed' &&
      requestData.profiles?.email
    ) {
      try {
        // Fetch entities for the completion email
        const { data: entities } = await supabase
          .from('request_entities')
          .select('*')
          .eq('request_id', payload.request_id) as { data: any[] | null; error: any };

        if (entities) {
          await sendCompletionNotification(
            requestData.profiles.email,
            requestData,
            entities
          );
        }
      } catch (emailError) {
        console.error('Failed to send completion notification:', emailError);
        // Don't fail the webhook if email fails
      }
    }

    // Send admin alert if status is failed
    if (payload.status === 'failed' && payload.reason) {
      try {
        // Get admin user's email
        const { data: adminData } = await supabase
          .from('profiles')
          .select('email')
          .eq('role', 'admin')
          .limit(1)
          .single() as { data: { email: string } | null; error: any };

        if (adminData?.email) {
          await sendAdminFailureAlert(
            adminData.email,
            payload.request_id,
            payload.reason
          );
        }
      } catch (emailError) {
        console.error('Failed to send admin failure alert:', emailError);
        // Don't fail the webhook if email fails
      }
    }

    // Audit log: webhook status update processed
    await logAuditFromRequest(supabase, request, {
      action: 'request_created',
      resourceType: 'request',
      resourceId: payload.request_id,
      details: {
        webhook_action: 'status_update',
        new_status: payload.status,
        entity_count: payload.entities?.length || 0,
      },
    });

    return NextResponse.json(
      {
        success: true,
        request_id: payload.request_id,
        status: payload.status,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Webhook processing error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
