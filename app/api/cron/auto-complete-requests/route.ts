/**
 * Auto-Complete Requests Cron Job
 * Checks for requests where all entities are completed and marks the request
 * as completed, notifying the processor.
 * GET /api/cron/auto-complete-requests
 *
 * Expected to be called by Vercel Cron every 15 minutes with CRON_SECRET in headers
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendCompletionNotification } from '@/lib/sendgrid';
import { triggerWebhookForRequest } from '@/lib/webhook';
import { triggerV3CompletionWebhook } from '@/lib/webhook-v3';

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
    const BATCH_SIZE = 200;

    let completed = 0;
    let checked = 0;
    const errors: { requestId: string; error: string }[] = [];
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      // Fetch a batch of active requests with cursor pagination
      let query = supabase
        .from('requests')
        .select('id, client_id, requested_by, batch_id, loan_number, intake_method, product_type, external_request_token, status, notes, created_at, updated_at, completed_at')
        .not('status', 'eq', 'completed')
        .not('status', 'eq', 'failed')
        .order('created_at', { ascending: true })
        .limit(BATCH_SIZE);

      if (cursor) {
        query = query.gt('created_at', cursor);
      }

      const { data: activeRequests, error: requestsError } = await query as { data: any[] | null; error: any };

      if (requestsError) {
        console.error('Failed to fetch active requests:', requestsError);
        return NextResponse.json(
          { error: 'Failed to fetch requests' },
          { status: 500 }
        );
      }

      if (!activeRequests || activeRequests.length === 0) {
        hasMore = false;
        break;
      }

      // Update cursor to last item's created_at for next batch
      cursor = activeRequests[activeRequests.length - 1].created_at;
      hasMore = activeRequests.length === BATCH_SIZE;
      checked += activeRequests.length;

      console.log(`[auto-complete] Processing batch of ${activeRequests.length} requests (total checked: ${checked})`);

      // Bulk-fetch all entities for this batch in a single query (eliminates N+1)
      const requestIds = activeRequests.map((r: any) => r.id);
      const { data: allEntities, error: bulkEntitiesError } = await supabase
        .from('request_entities')
        .select('id, request_id, entity_name, tid, tid_kind, address, city, state, zip_code, form_type, years, signer_first_name, signer_last_name, signer_email, signature_id, signature_created_at, signed_8821_url, status, employment_data, gross_receipts, compliance_score, transcript_urls, completed_at, created_at, updated_at')
        .in('request_id', requestIds) as { data: any[] | null; error: any };

      if (bulkEntitiesError) {
        console.error(`[auto-complete] Failed to bulk-fetch entities:`, bulkEntitiesError);
        // Fall through — individual requests will be skipped
      }

      // Group entities by request_id for O(1) lookup
      const entitiesByRequest = new Map<string, any[]>();
      for (const entity of (allEntities || [])) {
        const list = entitiesByRequest.get(entity.request_id) || [];
        list.push(entity);
        entitiesByRequest.set(entity.request_id, list);
      }

      for (const req of activeRequests) {
        try {
          const entities = entitiesByRequest.get(req.id);

          // Skip if no entities (shouldn't happen, but guard)
          if (!entities || entities.length === 0) {
            continue;
          }

          // Check if ALL entities have status 'completed'
          const allCompleted = entities.every((e: any) => e.status === 'completed');
          if (!allCompleted) {
            continue;
          }

          // Update request to completed
          const now = new Date().toISOString();
          const { error: updateError } = await supabase
            .from('requests')
            .update({
              status: 'completed',
              completed_at: now,
            })
            .eq('id', req.id);

          if (updateError) {
            console.error(`[auto-complete] Failed to update request ${req.id}:`, updateError);
            errors.push({ requestId: req.id, error: 'Failed to update request status' });
            continue;
          }

          // Get processor profile and send completion notification
          try {
            const { data: processor } = await supabase
              .from('profiles')
              .select('email')
              .eq('id', req.requested_by)
              .single() as { data: { email: string } | null; error: any };

            if (processor) {
              await sendCompletionNotification(processor.email, req, entities);
            }
          } catch (notifErr) {
            console.error(`[auto-complete] Notification error for request ${req.id}:`, notifErr);
          }

          // Trigger webhooks for API-intake requests (e.g., ClearFirm)
          // v3: structured risk_signals + completion signal
          // v2: lightweight "complete" signal (backward-compat)
          try {
            await Promise.all([
              triggerV3CompletionWebhook(supabase, req.id),
              triggerWebhookForRequest(supabase, req.id),
            ]);
          } catch (webhookErr) {
            console.error(`[auto-complete] Webhook trigger failed for ${req.id}:`, webhookErr);
          }

          completed++;
          console.log(`[auto-complete] Completed request ${req.id} (loan: ${req.loan_number})`);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'Unknown error';
          console.error(`[auto-complete] Error processing request ${req.id}:`, errorMessage);
          errors.push({ requestId: req.id, error: errorMessage });
        }
      }
    }

    if (checked === 0) {
      return NextResponse.json({
        success: true,
        completed: 0,
        checked: 0,
        message: 'No active requests to check',
        processedAt: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      success: true,
      completed,
      checked,
      processedAt: new Date().toISOString(),
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Auto-complete requests cron error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Cron job failed', details: errorMessage },
      { status: 500 }
    );
  }
}
