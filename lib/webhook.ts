/**
 * Outbound Webhook Delivery Engine
 *
 * Handles building payloads and delivering completed transcript data
 * to API clients (e.g., ClearFirm) via webhook callbacks.
 *
 * Payload spec follows ClearFirm Integration Spec v1:
 *   Completed: { request_token, status: "completed", reports: [{ type, html }] }
 *   Error:     { request_token, status: "error", error: "..." }
 *
 * Retry: exponential backoff (2s, 4s, 8s), max 3 attempts.
 * 5xx → retry, 404 → dead (no retry), unreachable → retry.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// --- Types ---

export interface WebhookReport {
  type: string;             // e.g. "1120S", "1065", "1040", "941", "BMF_ENTITY"
  transcript_type: string;  // "income" | "payroll" | "entity" — categorizes the report
  html: string;             // Full HTML content of the rendered IRS transcript
  tax_period?: string;      // e.g. "2024", "09-30-2025" for quarterly
  filename?: string;        // Original filename for reference
}

export interface WebhookCompletedPayload {
  request_token: string;
  status: 'completed';
  reports: WebhookReport[];
  entity_info?: {
    entity_name: string;
    tin: string;
    filing_requirements?: string;
    naics_code?: string;
    establishment_date?: string;
  };
}

export interface WebhookErrorPayload {
  request_token: string;
  status: 'error';
  error: string;
}

export type WebhookPayload = WebhookCompletedPayload | WebhookErrorPayload;

export interface DeliveryResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

// --- Payload Builders ---

/**
 * Build a "completed" webhook payload with inline HTML transcript content.
 * Reads HTML files from Supabase storage and includes them in the payload.
 * Falls back to PDF download URLs if no HTML is available.
 */
export async function buildCompletedPayload(
  supabase: SupabaseClient,
  requestToken: string,
  entities: Array<{
    id: string;
    entity_name: string;
    tid: string;
    form_type: string;
    years: string[];
    transcript_html_urls: string[] | null;
    transcript_urls: string[] | null;
    gross_receipts: Record<string, any> | null;
  }>
): Promise<WebhookCompletedPayload> {
  const reports: WebhookReport[] = [];

  for (const entity of entities) {
    const htmlUrls = entity.transcript_html_urls || [];

    // Helper to categorize transcript type from filename/form
    function categorizeTranscript(filename: string, formType: string): { transcriptType: string; reportType: string; taxPeriod: string } {
      const lowerName = filename.toLowerCase();
      const lowerForm = formType.toUpperCase();

      // Entity Transcript
      if (lowerName.includes('entity transcript') || lowerForm === 'BMF_ENTITY') {
        return { transcriptType: 'entity', reportType: 'BMF_ENTITY', taxPeriod: '' };
      }
      // 941/940 Payroll
      if (lowerForm === '941' || lowerForm === '940' || lowerName.includes('941') || lowerName.includes('940')) {
        // Extract quarter period from filename (e.g. "941 Account Transcript - 09-30-2025")
        const periodMatch = lowerName.match(/(\d{2}-\d{2}-\d{4})/);
        const yearMatch = lowerName.match(/(\d{4})/);
        return {
          transcriptType: 'payroll',
          reportType: lowerForm === '940' ? '940' : '941',
          taxPeriod: periodMatch ? periodMatch[1] : yearMatch ? yearMatch[1] : '',
        };
      }
      // Standard income transcript
      const yearMatch = lowerName.match(/(\d{4})/);
      return { transcriptType: 'income', reportType: formType, taxPeriod: yearMatch ? yearMatch[1] : '' };
    }

    if (htmlUrls.length > 0) {
      // Read HTML content from Supabase storage
      for (const htmlPath of htmlUrls) {
        try {
          const { data, error } = await supabase.storage
            .from('uploads')
            .download(htmlPath);

          if (error || !data) {
            console.error(`[webhook] Failed to download HTML at ${htmlPath}:`, error);
            continue;
          }

          const htmlContent = await data.text();
          const filename = htmlPath.split('/').pop() || '';
          const { transcriptType, reportType, taxPeriod } = categorizeTranscript(filename, entity.form_type);

          reports.push({
            type: reportType,
            transcript_type: transcriptType,
            html: htmlContent,
            tax_period: taxPeriod || undefined,
            filename: filename.replace(/^\d+-/, ''), // Remove timestamp prefix
          });
        } catch (err) {
          console.error(`[webhook] Error reading HTML file ${htmlPath}:`, err);
        }
      }
    } else if (entity.transcript_urls && entity.transcript_urls.length > 0) {
      // Fallback: generate signed download URLs for PDFs
      // ClearFirm prefers HTML but can handle PDF URLs as interim solution
      for (const pdfPath of entity.transcript_urls) {
        try {
          const { data: signedUrlData } = await supabase.storage
            .from('uploads')
            .createSignedUrl(pdfPath, 3600); // 1 hour expiry

          if (signedUrlData?.signedUrl) {
            const filename = pdfPath.split('/').pop() || '';
            const { transcriptType, reportType, taxPeriod } = categorizeTranscript(filename, entity.form_type);

            reports.push({
              type: reportType,
              transcript_type: transcriptType,
              html: `<!-- PDF transcript: download URL valid for 1 hour -->\n<a href="${signedUrlData.signedUrl}">${filename}</a>`,
              tax_period: taxPeriod || undefined,
              filename: filename.replace(/^\d+-/, ''),
            });
          }
        } catch (err) {
          console.error(`[webhook] Error creating signed URL for ${pdfPath}:`, err);
        }
      }
    }
  }

  // Build entity_info from the first entity's entity transcript data (if available)
  let entityInfo: WebhookCompletedPayload['entity_info'];
  if (entities.length > 0) {
    const primaryEntity = entities[0];
    const entityTranscriptData = primaryEntity.gross_receipts?.entity_transcript as Record<string, string> | undefined;
    entityInfo = {
      entity_name: primaryEntity.entity_name,
      tin: primaryEntity.tid,
      filing_requirements: entityTranscriptData?.filingRequirements,
      naics_code: entityTranscriptData?.naicsCode,
      establishment_date: entityTranscriptData?.establishmentDate,
    };
  }

  return {
    request_token: requestToken,
    status: 'completed',
    reports,
    entity_info: entityInfo,
  };
}

/**
 * Build an "error" webhook payload.
 */
export function buildErrorPayload(
  requestToken: string,
  errorMessage: string
): WebhookErrorPayload {
  return {
    request_token: requestToken,
    status: 'error',
    error: errorMessage,
  };
}

// --- HMAC Signing ---

/**
 * Sign a payload string with HMAC-SHA256.
 * ClearFirm can verify via the X-ModernTax-Signature header.
 */
export function signPayload(payloadString: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
}

// --- Delivery ---

/**
 * Attempt to deliver a webhook. Updates the webhook_deliveries row with results.
 *
 * Response handling per ClearFirm spec:
 *   2xx → delivered (success)
 *   404 → dead (request_token not found in ClearFirm, do NOT retry)
 *   400 → dead (payload format error, do NOT retry)
 *   5xx → failed (retry with exponential backoff)
 *   Network error → failed (retry)
 */
export async function deliverWebhook(
  supabase: SupabaseClient,
  deliveryId: string
): Promise<DeliveryResult> {
  // Fetch the delivery record
  const { data: delivery, error: fetchError } = await supabase
    .from('webhook_deliveries')
    .select('*')
    .eq('id', deliveryId)
    .single();

  if (fetchError || !delivery) {
    console.error(`[webhook] Delivery ${deliveryId} not found:`, fetchError);
    return { success: false, error: 'Delivery record not found' };
  }

  if (delivery.status === 'delivered' || delivery.status === 'dead') {
    return { success: delivery.status === 'delivered' };
  }

  // Mark as sending
  await supabase
    .from('webhook_deliveries')
    .update({ status: 'sending', updated_at: new Date().toISOString() })
    .eq('id', deliveryId);

  const payloadString = JSON.stringify(delivery.payload);
  const now = new Date().toISOString();

  try {
    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'ModernTax-Webhook/1.0',
    };

    // Sign if we have a secret for this client
    const { data: client } = await supabase
      .from('clients')
      .select('webhook_secret')
      .eq('id', delivery.client_id)
      .single();

    if (client?.webhook_secret) {
      headers['X-ModernTax-Signature'] = signPayload(payloadString, client.webhook_secret);
    }

    // POST to webhook URL with 10s timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(delivery.webhook_url, {
      method: 'POST',
      headers,
      body: payloadString,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const statusCode = response.status;
    const attempt = delivery.attempts + 1;

    if (statusCode >= 200 && statusCode < 300) {
      // Success — mark delivered
      await supabase
        .from('webhook_deliveries')
        .update({
          status: 'delivered',
          attempts: attempt,
          last_attempt_at: now,
          last_status_code: statusCode,
          last_error: null,
          delivered_at: now,
          updated_at: now,
        })
        .eq('id', deliveryId);

      console.log(`[webhook] Delivered ${deliveryId} to ${delivery.webhook_url} (${statusCode})`);
      return { success: true, statusCode };
    }

    if (statusCode === 404 || statusCode === 400) {
      // Client says request_token not found or bad payload — do NOT retry
      const responseText = await response.text().catch(() => '');
      await supabase
        .from('webhook_deliveries')
        .update({
          status: 'dead',
          attempts: attempt,
          last_attempt_at: now,
          last_status_code: statusCode,
          last_error: `HTTP ${statusCode}: ${responseText.slice(0, 500)}`,
          updated_at: now,
        })
        .eq('id', deliveryId);

      console.error(`[webhook] Dead ${deliveryId}: HTTP ${statusCode} from ${delivery.webhook_url}`);
      return { success: false, statusCode, error: `HTTP ${statusCode}` };
    }

    // 5xx or other error — retry with exponential backoff
    const responseText = await response.text().catch(() => '');
    const backoffMs = 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s
    const nextRetry = new Date(Date.now() + backoffMs).toISOString();
    const newStatus = attempt >= delivery.max_attempts ? 'dead' : 'failed';

    await supabase
      .from('webhook_deliveries')
      .update({
        status: newStatus,
        attempts: attempt,
        last_attempt_at: now,
        last_status_code: statusCode,
        last_error: `HTTP ${statusCode}: ${responseText.slice(0, 500)}`,
        next_retry_at: newStatus === 'failed' ? nextRetry : null,
        updated_at: now,
      })
      .eq('id', deliveryId);

    console.error(`[webhook] ${newStatus === 'dead' ? 'Dead' : 'Failed'} ${deliveryId}: HTTP ${statusCode}, attempt ${attempt}/${delivery.max_attempts}`);
    return { success: false, statusCode, error: `HTTP ${statusCode}` };

  } catch (err) {
    // Network error, timeout, etc. — retry
    const attempt = delivery.attempts + 1;
    const errorMessage = err instanceof Error ? err.message : 'Network error';
    const backoffMs = 2000 * Math.pow(2, attempt - 1);
    const nextRetry = new Date(Date.now() + backoffMs).toISOString();
    const newStatus = attempt >= delivery.max_attempts ? 'dead' : 'failed';

    await supabase
      .from('webhook_deliveries')
      .update({
        status: newStatus,
        attempts: attempt,
        last_attempt_at: now,
        last_status_code: null,
        last_error: errorMessage,
        next_retry_at: newStatus === 'failed' ? nextRetry : null,
        updated_at: now,
      })
      .eq('id', deliveryId);

    console.error(`[webhook] ${newStatus === 'dead' ? 'Dead' : 'Failed'} ${deliveryId}: ${errorMessage}, attempt ${attempt}/${delivery.max_attempts}`);
    return { success: false, error: errorMessage };
  }
}

// --- Enqueue ---

/**
 * Enqueue a webhook delivery. Deduplicates by request_id to prevent
 * double-delivery when both upload-transcript and auto-complete cron fire.
 * Immediately attempts delivery after enqueueing.
 */
export async function enqueueWebhookDelivery(
  supabase: SupabaseClient,
  requestId: string,
  clientId: string,
  webhookUrl: string,
  payload: WebhookPayload
): Promise<string | null> {
  // Check for existing non-dead delivery for this request
  const { data: existing } = await supabase
    .from('webhook_deliveries')
    .select('id, status')
    .eq('request_id', requestId)
    .in('status', ['pending', 'sending', 'delivered', 'failed'])
    .limit(1)
    .maybeSingle();

  if (existing) {
    console.log(`[webhook] Skipping duplicate delivery for request ${requestId} (existing: ${existing.id}, status: ${existing.status})`);
    return null;
  }

  // Insert new delivery record
  const { data: delivery, error: insertError } = await supabase
    .from('webhook_deliveries')
    .insert({
      request_id: requestId,
      client_id: clientId,
      webhook_url: webhookUrl,
      payload: payload as any,
      status: 'pending',
    })
    .select('id')
    .single();

  if (insertError || !delivery) {
    console.error(`[webhook] Failed to enqueue delivery for request ${requestId}:`, insertError);
    return null;
  }

  console.log(`[webhook] Enqueued delivery ${delivery.id} for request ${requestId}`);

  // Attempt immediate delivery (don't await — fire and forget for speed)
  deliverWebhook(supabase, delivery.id).catch((err) => {
    console.error(`[webhook] Immediate delivery attempt failed for ${delivery.id}:`, err);
  });

  return delivery.id;
}

// --- Orchestrator ---

/**
 * Trigger a webhook for a completed request.
 * Checks if the client has a webhook_url and the request is API-origin,
 * then builds the payload and enqueues delivery.
 */
export async function triggerWebhookForRequest(
  supabase: SupabaseClient,
  requestId: string
): Promise<string | null> {
  // Fetch request with client info
  const { data: req, error: reqError } = await supabase
    .from('requests')
    .select('id, client_id, intake_method, external_request_token, status, notes')
    .eq('id', requestId)
    .single();

  if (reqError || !req) {
    console.error(`[webhook] Request ${requestId} not found:`, reqError);
    return null;
  }

  // Only trigger for API-intake requests with an external token
  if (req.intake_method !== 'api' || !req.external_request_token) {
    return null;
  }

  // Check if client has a webhook URL
  const { data: client } = await supabase
    .from('clients')
    .select('id, webhook_url, webhook_secret')
    .eq('id', req.client_id)
    .single();

  if (!client?.webhook_url) {
    return null;
  }

  // Build payload based on request status
  let payload: WebhookPayload;

  if (req.status === 'completed') {
    // Fetch entities with transcript data (including entity transcript info)
    const { data: entities } = await supabase
      .from('request_entities')
      .select('id, entity_name, tid, form_type, years, transcript_html_urls, transcript_urls, gross_receipts')
      .eq('request_id', requestId);

    if (!entities || entities.length === 0) {
      console.error(`[webhook] No entities found for request ${requestId}`);
      return null;
    }

    payload = await buildCompletedPayload(
      supabase,
      req.external_request_token,
      entities as any
    );
  } else if (req.status === 'failed') {
    const errorMessage = req.notes || 'Transcript retrieval failed. Contact ModernTax support.';
    payload = buildErrorPayload(req.external_request_token, errorMessage);
  } else {
    // Not a terminal status — don't send webhook
    return null;
  }

  return enqueueWebhookDelivery(
    supabase,
    requestId,
    client.id,
    client.webhook_url,
    payload
  );
}

/**
 * Trigger an error webhook for a failed request.
 * Called when admin marks a request as failed or when all entities fail.
 */
export async function triggerErrorWebhookForRequest(
  supabase: SupabaseClient,
  requestId: string,
  errorMessage: string
): Promise<string | null> {
  const { data: req } = await supabase
    .from('requests')
    .select('id, client_id, intake_method, external_request_token')
    .eq('id', requestId)
    .single();

  if (!req || req.intake_method !== 'api' || !req.external_request_token) {
    return null;
  }

  const { data: client } = await supabase
    .from('clients')
    .select('id, webhook_url')
    .eq('id', req.client_id)
    .single();

  if (!client?.webhook_url) {
    return null;
  }

  const payload = buildErrorPayload(req.external_request_token, errorMessage);

  return enqueueWebhookDelivery(
    supabase,
    requestId,
    client.id,
    client.webhook_url,
    payload
  );
}
