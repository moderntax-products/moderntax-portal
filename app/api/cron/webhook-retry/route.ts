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

export const maxDuration = 60;

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
      .limit(50); // Process up to 50 per run (runs every 5 min)

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
      .limit(20);

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

    // Process deliveries in parallel batches of 5 to avoid timeout
    const BATCH_CONCURRENCY = 5;
    for (let i = 0; i < allDeliveries.length; i += BATCH_CONCURRENCY) {
      const batch = allDeliveries.slice(i, i + BATCH_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (delivery) => {
          const result = await deliverWebhook(supabase, delivery.id);
          return { delivery, result };
        })
      );

      for (const settled of results) {
        if (settled.status === 'rejected') {
          const errorMessage = settled.reason instanceof Error ? settled.reason.message : 'Unknown error';
          errors.push({ deliveryId: 'unknown', error: errorMessage });
          continue;
        }

        const { delivery, result } = settled.value;
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
          }
        }
      }
    }

    // Send a single batched admin alert for all dead deliveries (instead of per-delivery loop)
    if (dead > 0) {
      try {
        const { data: admins } = await supabase
          .from('profiles')
          .select('email')
          .eq('role', 'admin');

        if (admins && admins.length > 0) {
          const sgMail = require('@sendgrid/mail');
          sgMail.setApiKey(process.env.SENDGRID_API_KEY);

          // Build a single summary email
          const deadDeliveryIds = allDeliveries
            .slice(0, 10) // Cap at 10 IDs in the email
            .map((d) => d.id)
            .join(', ');

          const alertPromises = admins.map((admin: any) =>
            sgMail.send({
              to: admin.email,
              from: {
                email: process.env.SENDGRID_FROM_EMAIL || 'alerts@moderntax.io',
                name: 'ModernTax Alerts',
              },
              subject: `Webhook Delivery Alert — ${dead} dead delivery(ies)`,
              html: `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: #dc2626; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
    <h2 style="margin: 0;">Webhook Deliveries Failed</h2>
  </div>
  <div style="padding: 24px; background: white; border: 1px solid #e5e7eb;">
    <p><strong>${dead}</strong> webhook delivery(ies) permanently failed after max retries.</p>
    <p style="color: #6b7280; font-size: 14px;">Delivery IDs: ${deadDeliveryIds}</p>
    <p>Check the <code>webhook_deliveries</code> table for error details. You may need to manually resend or contact the API client.</p>
  </div>
</div>`.trim(),
            }).catch((err: any) => console.error(`[webhook-retry] Alert to ${admin.email} failed:`, err))
          );
          await Promise.all(alertPromises);
        }
      } catch (alertErr) {
        console.error(`[webhook-retry] Failed to send admin alerts:`, alertErr);
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
