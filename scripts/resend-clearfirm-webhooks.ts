/**
 * Resend HTML webhooks for ClearFirm requests 269, 270, 272, 274
 *
 * ClearFirm updated their parser (commit 0579fc7) and needs fresh
 * incremental HTML deliveries to populate their v2.1 data format.
 *
 * This script:
 * 1. Finds all entities with HTML files for each request
 * 2. Re-enqueues incremental webhook deliveries for each HTML file
 * 3. Fires them immediately
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.vercel-prod') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const REQUEST_TOKENS = [
  'CF-cherrytech-269',
  'CF-cherrytech-270',
  'CF-cherrytech-272',
  'CF-cherrytech-274',
];

async function main() {
  console.log('=== ClearFirm Webhook Resend ===\n');

  // Get request details for each token
  for (const token of REQUEST_TOKENS) {
    console.log(`\n--- ${token} ---`);

    const { data: request } = await supabase
      .from('requests')
      .select('id, client_id, external_request_token, status')
      .eq('external_request_token', token)
      .single();

    if (!request) {
      console.log(`  ❌ Request not found for token ${token}`);
      continue;
    }

    console.log(`  Request ID: ${request.id}`);
    console.log(`  Status: ${request.status}`);

    // Get client webhook info
    const { data: client } = await supabase
      .from('clients')
      .select('id, webhook_url, webhook_secret')
      .eq('id', request.client_id)
      .single();

    if (!client?.webhook_url) {
      console.log(`  ❌ No webhook URL for client`);
      continue;
    }

    console.log(`  Webhook URL: ${client.webhook_url}`);

    // Get all entities with HTML files
    const { data: entities } = await supabase
      .from('request_entities')
      .select('id, entity_name, form_type, transcript_urls, transcript_html_urls')
      .eq('request_id', request.id);

    if (!entities || entities.length === 0) {
      console.log(`  ❌ No entities found`);
      continue;
    }

    // Collect all HTML file paths
    const htmlFiles: Array<{ entityId: string; entityName: string; formType: string; path: string }> = [];

    for (const entity of entities) {
      // Check transcript_urls for .html files
      for (const url of (entity.transcript_urls || [])) {
        if (url.endsWith('.html') || url.endsWith('.htm')) {
          htmlFiles.push({
            entityId: entity.id,
            entityName: entity.entity_name,
            formType: entity.form_type || '',
            path: url,
          });
        }
      }
      // Check transcript_html_urls for .html files
      for (const url of (entity.transcript_html_urls || [])) {
        if (url.endsWith('.html') || url.endsWith('.htm')) {
          htmlFiles.push({
            entityId: entity.id,
            entityName: entity.entity_name,
            formType: entity.form_type || '',
            path: url,
          });
        }
      }
    }

    console.log(`  Found ${htmlFiles.length} HTML files across ${entities.length} entities`);

    if (htmlFiles.length === 0) {
      // Check if there are PDFs only
      const pdfCount = entities.reduce((sum, e) => {
        const pdfs = [...(e.transcript_urls || []), ...(e.transcript_html_urls || [])]
          .filter((u: string) => u.endsWith('.pdf'));
        return sum + pdfs.length;
      }, 0);
      console.log(`  ⚠️ No HTML files — ${pdfCount} PDFs only. Cannot send HTML webhooks.`);
      continue;
    }

    // Build and enqueue incremental webhook for each HTML file
    let enqueued = 0;
    for (const file of htmlFiles) {
      const filename = file.path.split('/').pop() || '';
      const cleanFilename = filename.replace(/^\d+-/, '');
      console.log(`  📤 ${file.entityName} — ${cleanFilename}`);

      // Download HTML content
      const { data: fileData, error: dlError } = await supabase.storage
        .from('uploads')
        .download(file.path);

      if (dlError || !fileData) {
        console.log(`    ❌ Failed to download: ${dlError?.message}`);
        continue;
      }

      const htmlContent = await fileData.text();
      if (htmlContent.length < 100) {
        console.log(`    ❌ File too small (${htmlContent.length} chars), skipping`);
        continue;
      }

      // Build file type from filename
      const lower = cleanFilename.toLowerCase();
      let fileType = `${file.formType.toLowerCase()}_transcript`;
      if (lower.includes('entity transcript')) fileType = 'entity_transcript';
      else if (lower.includes('941')) fileType = '941_account_transcript';
      else if (lower.includes('1120s')) fileType = '1120s_transcript';
      else if (lower.includes('1120') && !lower.includes('1120s')) fileType = '1120_transcript';
      else if (lower.includes('1065')) fileType = '1065_transcript';

      // Extract year
      const yearMatch = cleanFilename.match(/(20\d{2})/);
      const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

      // Generate file_id
      const crypto = await import('crypto');
      const hash = crypto.createHash('md5').update(`${file.entityId}:${file.path}`).digest('hex').slice(0, 12);
      const fileId = `mt_${hash}`;

      const payload = {
        request_token: token,
        status: 'partial' as const,
        files: [{
          file_id: fileId,
          type: fileType,
          year,
          entity_name: file.entityName,
          html: htmlContent,
          created_at: new Date().toISOString(),
        }],
      };

      // Enqueue delivery
      const { data: delivery, error: insertError } = await supabase
        .from('webhook_deliveries')
        .insert({
          request_id: request.id,
          client_id: client.id,
          webhook_url: client.webhook_url,
          payload: payload as any,
          status: 'pending',
          max_attempts: 5,
        })
        .select('id')
        .single();

      if (insertError) {
        console.log(`    ❌ Failed to enqueue: ${insertError.message}`);
        continue;
      }

      console.log(`    ✅ Enqueued delivery ${delivery!.id} (${(JSON.stringify(payload).length / 1024).toFixed(1)}KB)`);
      enqueued++;
    }

    // Also enqueue a "complete" signal if request is completed
    if (request.status === 'completed') {
      const completePayload = {
        request_token: token,
        status: 'complete' as const,
        files: [],
      };

      const { data: completeDel } = await supabase
        .from('webhook_deliveries')
        .insert({
          request_id: request.id,
          client_id: client.id,
          webhook_url: client.webhook_url,
          payload: completePayload as any,
          status: 'pending',
          max_attempts: 5,
        })
        .select('id')
        .single();

      if (completeDel) {
        console.log(`  📤 Enqueued "complete" signal: ${completeDel.id}`);
        enqueued++;
      }
    }

    console.log(`  ✅ ${enqueued} deliveries enqueued for ${token}`);
  }

  // Now deliver all pending
  console.log('\n=== Delivering all pending webhooks ===\n');

  const { data: pendingDeliveries } = await supabase
    .from('webhook_deliveries')
    .select('id, payload')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  console.log(`Found ${pendingDeliveries?.length || 0} pending deliveries`);

  // Wake up Render endpoint first
  console.log('Waking up ClearFirm endpoint...');
  try {
    await fetch('https://clearfirm-api.onrender.com/api/v1/webhook/moderntax', { method: 'HEAD' });
    await new Promise(r => setTimeout(r, 3000));
  } catch (e) {
    await new Promise(r => setTimeout(r, 5000));
  }

  let delivered = 0;
  let failed = 0;

  for (const del of (pendingDeliveries || [])) {
    const payloadStr = JSON.stringify(del.payload);
    const now = new Date().toISOString();

    // Mark sending
    await supabase.from('webhook_deliveries').update({ status: 'sending' }).eq('id', del.id);

    try {
      // Get client secret for signing
      const { data: delRecord } = await supabase
        .from('webhook_deliveries')
        .select('client_id, webhook_url')
        .eq('id', del.id)
        .single();

      const { data: clientInfo } = await supabase
        .from('clients')
        .select('webhook_secret')
        .eq('id', delRecord!.client_id)
        .single();

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'ModernTax-Webhook/1.0',
      };

      if (clientInfo?.webhook_secret) {
        const crypto = await import('crypto');
        headers['X-ModernTax-Signature'] = crypto
          .createHmac('sha256', clientInfo.webhook_secret)
          .update(payloadStr)
          .digest('hex');
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      const resp = await fetch(delRecord!.webhook_url, {
        method: 'POST',
        headers,
        body: payloadStr,
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const status = resp.status;
      const body = await resp.text().catch(() => '');

      if (status >= 200 && status < 300) {
        await supabase.from('webhook_deliveries').update({
          status: 'delivered', attempts: 1, last_attempt_at: now,
          last_status_code: status, delivered_at: now, updated_at: now,
        }).eq('id', del.id);
        const token = (del.payload as any)?.request_token || '?';
        const fileType = (del.payload as any)?.files?.[0]?.type || (del.payload as any)?.status;
        console.log(`  ✅ ${del.id.slice(0, 8)} → ${token} ${fileType} (HTTP ${status})`);
        delivered++;
      } else {
        await supabase.from('webhook_deliveries').update({
          status: 'failed', attempts: 1, last_attempt_at: now,
          last_status_code: status, last_error: `HTTP ${status}: ${body.slice(0, 200)}`,
          updated_at: now,
        }).eq('id', del.id);
        console.log(`  ❌ ${del.id.slice(0, 8)} → HTTP ${status}: ${body.slice(0, 100)}`);
        failed++;
      }
    } catch (err: any) {
      await supabase.from('webhook_deliveries').update({
        status: 'failed', attempts: 1, last_attempt_at: now,
        last_error: err.message, updated_at: now,
      }).eq('id', del.id);
      console.log(`  ❌ ${del.id.slice(0, 8)} → ${err.message}`);
      failed++;
    }

    // Small delay between deliveries
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Delivered: ${delivered}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${(pendingDeliveries || []).length}`);
}

main().catch(console.error);
