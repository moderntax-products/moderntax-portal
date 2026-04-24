/**
 * Resend ClearFirm webhooks in v3 structured format
 *
 * Sends structured JSON (entity_profile, employment_compliance,
 * financial_verification, risk_signals) with raw HTML as secondary evidence.
 *
 * Targets: CF-cherrytech-270, 272, 274
 * (269 has PDFs only — needs fresh HTML retrieval by expert)
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  buildV3PayloadsForUpload,
  buildV3CompletionPayloads,
  type TranscriptUploadContext,
  type AnyWebhookV3Payload,
} from '../lib/webhook-v3';

dotenv.config({ path: path.resolve(__dirname, '../.env.vercel-prod') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const REQUEST_TOKENS = [
  'CF-cherrytech-270',
  'CF-cherrytech-272',
  'CF-cherrytech-274',
];

async function main() {
  console.log('=== ClearFirm v3 Structured Webhook Resend ===\n');

  const allPayloads: Array<{
    requestId: string;
    clientId: string;
    webhookUrl: string;
    payload: AnyWebhookV3Payload;
    token: string;
  }> = [];

  for (const token of REQUEST_TOKENS) {
    console.log(`\n--- ${token} ---`);

    const { data: request } = await supabase
      .from('requests')
      .select('id, client_id, external_request_token, status')
      .eq('external_request_token', token)
      .single();

    if (!request) {
      console.log(`  X Request not found`);
      continue;
    }

    const { data: client } = await supabase
      .from('clients')
      .select('id, webhook_url, webhook_secret')
      .eq('id', request.client_id)
      .single();

    if (!client?.webhook_url) {
      console.log(`  X No webhook URL`);
      continue;
    }

    // Get entities with full data
    const { data: entities } = await supabase
      .from('request_entities')
      .select('id, entity_name, tid, tid_kind, address, city, state, zip_code, form_type, years, signer_first_name, signer_last_name, gross_receipts, transcript_urls, transcript_html_urls')
      .eq('request_id', request.id) as { data: any[] | null; error: any };

    if (!entities || entities.length === 0) {
      console.log(`  X No entities`);
      continue;
    }

    for (const entity of entities) {
      // Collect HTML files
      const htmlPaths: string[] = [];
      for (const url of [...(entity.transcript_urls || []), ...(entity.transcript_html_urls || [])]) {
        if (url.endsWith('.html') || url.endsWith('.htm')) {
          htmlPaths.push(url);
        }
      }

      if (htmlPaths.length === 0) {
        console.log(`  ${entity.entity_name}: no HTML files`);
        continue;
      }

      console.log(`  ${entity.entity_name}: ${htmlPaths.length} HTML files`);

      for (const htmlPath of htmlPaths) {
        const filename = htmlPath.split('/').pop() || '';
        const cleanFilename = filename.replace(/^\d+-/, '');

        // Download HTML
        const { data: fileData } = await supabase.storage
          .from('uploads')
          .download(htmlPath);

        if (!fileData) {
          console.log(`    X Failed to download ${cleanFilename}`);
          continue;
        }

        const rawHtml = await fileData.text();
        if (rawHtml.length < 100) {
          console.log(`    X Too small: ${cleanFilename} (${rawHtml.length} chars)`);
          continue;
        }

        // Determine form type and year from filename
        const lower = cleanFilename.toLowerCase();
        let formType = entity.form_type || '';
        if (lower.includes('entity transcript')) formType = 'BMF_ENTITY';
        else if (lower.includes('941')) formType = '941';
        else if (lower.includes('1120s') || lower.includes('1120-s')) formType = '1120S';
        else if (lower.includes('1120') && !lower.includes('1120s')) formType = '1120';
        else if (lower.includes('1065')) formType = '1065';

        const yearMatch = cleanFilename.match(/(20\d{2})/);
        const taxYear = yearMatch ? yearMatch[1] : '';

        const category: 'entity' | 'payroll' | 'income' =
          formType === 'BMF_ENTITY' ? 'entity' :
          ['941', '940'].includes(formType) ? 'payroll' : 'income';

        // Get compliance data from gross_receipts if available
        const gr = entity.gross_receipts || {};
        let complianceData = null;
        const compKey = `${formType}_RoA_${taxYear}`;
        const compKeyAlt = `${formType}_Quarterly_${taxYear}`;
        const compEntry = gr[compKey] || gr[compKeyAlt];

        if (compEntry) {
          complianceData = {
            severity: compEntry.severity,
            flags: compEntry.flags,
            financials: compEntry.financials,
          };
        }

        // Entity data from entity_transcript
        const entityData = category === 'entity' ? (gr.entity_transcript || null) : null;

        // Build v3 payloads
        const ctx: TranscriptUploadContext = {
          requestToken: token,
          entity: {
            ...entity,
            request_id: request.id,
          },
          formType,
          taxYear,
          transcriptCategory: category,
          complianceData,
          entityData,
          rawHtml,
        };

        const payloads = buildV3PayloadsForUpload(ctx);

        for (const payload of payloads) {
          console.log(`    -> ${payload.record_type} (${payload.record_id}): ${cleanFilename}`);
          allPayloads.push({
            requestId: request.id,
            clientId: client.id,
            webhookUrl: client.webhook_url,
            payload,
            token,
          });
        }
      }
    }

    // Add completion payloads (risk_signals + complete)
    if (request.status === 'completed') {
      const completionPayloads = buildV3CompletionPayloads(token, entities);
      for (const payload of completionPayloads) {
        const rt = (payload as any).record_type || 'complete';
        console.log(`  -> ${rt} (completion)`);
        allPayloads.push({
          requestId: request.id,
          clientId: client.id,
          webhookUrl: client.webhook_url,
          payload,
          token,
        });
      }
    }
  }

  // Enqueue all
  console.log(`\n=== Enqueuing ${allPayloads.length} v3 deliveries ===\n`);

  const deliveryIds: string[] = [];
  for (const item of allPayloads) {
    const { data: delivery, error } = await supabase
      .from('webhook_deliveries')
      .insert({
        request_id: item.requestId,
        client_id: item.clientId,
        webhook_url: item.webhookUrl,
        payload: item.payload as any,
        status: 'pending',
        max_attempts: 5,
      })
      .select('id')
      .single();

    if (error || !delivery) {
      console.log(`  X Enqueue failed: ${error?.message}`);
      continue;
    }

    deliveryIds.push(delivery.id);
  }

  console.log(`Enqueued ${deliveryIds.length} deliveries`);

  // Deliver all
  console.log('\n=== Delivering ===\n');

  // Wake Render
  console.log('Waking ClearFirm endpoint...');
  try {
    await fetch('https://clearfirm-api.onrender.com/api/v1/webhook/moderntax', { method: 'HEAD' });
    await new Promise(r => setTimeout(r, 3000));
  } catch { await new Promise(r => setTimeout(r, 5000)); }

  let delivered = 0;
  let failed = 0;

  for (const delId of deliveryIds) {
    const { data: del } = await supabase
      .from('webhook_deliveries')
      .select('id, payload, client_id, webhook_url')
      .eq('id', delId)
      .single();

    if (!del) continue;

    const payloadStr = JSON.stringify(del.payload);
    const now = new Date().toISOString();

    await supabase.from('webhook_deliveries').update({ status: 'sending' }).eq('id', del.id);

    try {
      const { data: clientInfo } = await supabase
        .from('clients')
        .select('webhook_secret')
        .eq('id', del.client_id)
        .single();

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'ModernTax-Webhook/3.0',
      };

      if (clientInfo?.webhook_secret) {
        headers['X-ModernTax-Signature'] = crypto
          .createHmac('sha256', clientInfo.webhook_secret)
          .update(payloadStr)
          .digest('hex');
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      const resp = await fetch(del.webhook_url, {
        method: 'POST',
        headers,
        body: payloadStr,
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const status = resp.status;

      if (status >= 200 && status < 300) {
        await supabase.from('webhook_deliveries').update({
          status: 'delivered', attempts: 1, last_attempt_at: now,
          last_status_code: status, delivered_at: now, updated_at: now,
        }).eq('id', del.id);

        const p = del.payload as any;
        console.log(`  OK ${del.id.slice(0, 8)} -> ${p.request_token} ${p.record_type || p.status} (HTTP ${status})`);
        delivered++;
      } else {
        const body = await resp.text().catch(() => '');
        await supabase.from('webhook_deliveries').update({
          status: 'failed', attempts: 1, last_attempt_at: now,
          last_status_code: status, last_error: `HTTP ${status}: ${body.slice(0, 200)}`,
          updated_at: now,
        }).eq('id', del.id);
        console.log(`  FAIL ${del.id.slice(0, 8)} -> HTTP ${status}: ${body.slice(0, 100)}`);
        failed++;
      }
    } catch (err: any) {
      await supabase.from('webhook_deliveries').update({
        status: 'failed', attempts: 1, last_attempt_at: now,
        last_error: err.message, updated_at: now,
      }).eq('id', del.id);
      console.log(`  FAIL ${del.id.slice(0, 8)} -> ${err.message}`);
      failed++;
    }

    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Delivered: ${delivered}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${deliveryIds.length}`);
}

main().catch(console.error);
