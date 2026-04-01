/**
 * Webhook Retry Cron Job
 * GET /api/cron/webhook-retry
 *
 * Retries failed webhook deliveries with exponential backoff.
 * Sends admin alert for permanently failed (dead) deliveries.
 * Runs every 5 minutes via Vercel Cron.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { deliverWebhook } from '@/lib/webhook';

export async function GET(request: NextRequest) {
  try {
    // Validate CRON_SECRET
    const cronSecret = request.headers.get('Authorization');
    const expectedSecret = process.env.CRON_SECRET;

    if (!cronSecret || !expectedSecret || cronSecret !== `Bearer ${expectedSecret}`) {
      return NextResponse.json(
        { error: 'Unauthorized: Invalid CRON_SECRET' },
        { status: 401 }
      );
    }

    const supabase = createAdminClient();

    // 1. Find failed deliveries ready for retry
    const { data: failedDeliveries, error: failedError } = await supabase
      .from('webhook_deliveries')
      .select('id, request_id, webhook_url, attempts, max_attempts, last_error')
      .eq('status', 'failed')
      .lte('next_retry_at', new Date().toISOString())
      .order('next_retry_at', { ascending: true })
      .limit(20); // Process up to 20 per run to avoid timeout

    if (failedError) {
      console.error('[webhook-retry] Failed to fetch deliveries:', failedError);
      return NextResponse.json(
        { error: 'Failed to fetch deliveries' },
        { status: 500 }
      );
    }

    // 2. Find orphaned pending deliveries (> 60s old, initial attempt never ran)
    const sixtySecondsAgo = new Date(Date.now() - 60000).toISOString();
    const { data: orphanedDeliveries } = await supabase
      .from('webhook_deliveries')
      .select('id, request_id, webhook_url, attempts, max_attempts, last_error')
      .eq('status', 'pending')
      .lt('created_at', sixtySecondsAgo)
      .limit(10);

    const allDeliveries = [
      ...(failedDeliveries || []),
      ...(orphanedDeliveries || []),
    ];

    if (allDeliveries.length === 0) {
      return NextResponse.json({
        success: true,
        retried: 0,
        delivered: 0,
        dead: 0,
        message: 'No deliveries to retry',
        processedAt: new Date().toISOString(),
      });
    }

    let retried = 0;
    let delivered = 0;
    let dead = 0;
    const errors: { deliveryId: string; error: string }[] = [];

    for (const delivery of allDeliveries) {
      try {
        const result = await deliverWebhook(supabase, delivery.id);
        retried++;

        if (result.success) {
          delivered++;
          console.log(`[webhook-retry] Delivered ${delivery.id} to ${delivery.webhook_url}`);
        } else {
          // Check if it went dead
          const { data: updated } = await supabase
            .from('webhook_deliveries')
            .select('status')
            .eq('id', delivery.id)
            .single();

          if (updated?.status === 'dead') {
            dead++;

            // Send admin alert for dead deliveries
            try {
              const { data: admins } = await supabase
                .from('profiles')
                .select('email')
                .eq('role', 'admin');

              if (admins && admins.length > 0) {
                const sgMail = require('@sendgrid/mail');
                sgMail.setApiKey(process.env.SENDGRID_API_KEY);

                for (const admin of admins) {
                  await sgMail.send({
                    to: admin.email,
                    from: {
                      email: process.env.SENDGRID_FROM_EMAIL || 'alerts@moderntax.io',
                      name: 'ModernTax Alerts',
                    },
                    subject: `⚠️ Webhook Delivery Failed — Request ${delivery.request_id}`,
                    html: `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: #dc2626; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
    <h2 style="margin: 0;">Webhook Delivery Failed</h2>
  </div>
  <div style="padding: 24px; background: white; border: 1px solid #e5e7eb;">
    <p>A webhook delivery has permanently failed after ${delivery.max_attempts || 3} attempts.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
      <tr><td style="padding: 8px; font-weight: bold; color: #6b7280;">Request ID</td><td style="padding: 8px;">${delivery.request_id}</td></tr>
      <tr><td style="padding: 8px; font-weight: bold; color: #6b7280;">Webhook URL</td><td style="padding: 8px;">${delivery.webhook_url}</td></tr>
      <tr><td style="padding: 8px; font-weight: bold; color: #6b7280;">Delivery ID</td><td style="padding: 8px;">${delivery.id}</td></tr>
    </table>
    <p>Check the <code>webhook_deliveries</code> table for error details. You may need to manually resend this webhook or contact the API client.</p>
  </div>
</div>`.trim(),
                  });
                }
              }
            } catch (alertErr) {
              console.error(`[webhook-retry] Failed to send admin alert for ${delivery.id}:`, alertErr);
            }
          }
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[webhook-retry] Error retrying ${delivery.id}:`, errorMessage);
        errors.push({ deliveryId: delivery.id, error: errorMessage });
      }
    }

    return NextResponse.json({
      success: true,
      retried,
      delivered,
      dead,
      processedAt: new Date().toISOString(),
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('[webhook-retry] Cron error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Webhook retry cron failed' },
      { status: 500 }
    );
  }
}
