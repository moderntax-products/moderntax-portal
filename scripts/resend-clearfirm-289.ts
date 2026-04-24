/**
 * Resend webhooks for ClearFirm request 289 (Laser & Skin Clinic Company)
 *
 * Request is completed on ModernTax side with 6 transcripts but ClearFirm
 * shows moderntax_timeout / moderntax_webhook_received_at = null.
 * The outbound webhook never landed. This script re-enqueues and delivers.
 *
 * Usage: npx tsx scripts/resend-clearfirm-289.ts
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as crypto from 'crypto';

dotenv.config({ path: path.resolve(__dirname, '../.env.vercel-prod') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const REQUEST_TOKEN = 'CF-clearfirm-289';

async function main() {
  console.log(`=== Resend ClearFirm ${REQUEST_TOKEN} ===\n`);

  // 1. Look up request
  const { data: request, error: reqErr } = await supabase
    .from('requests')
    .select('id, client_id, external_request_token, status')
    .eq('external_request_token', REQUEST_TOKEN)
    .single();

  if (reqErr || !request) {
    console.error('Request not found:', reqErr?.message);
    return;
  }

  console.log(`Request ID: ${request.id}`);
  console.log(`Status: ${request.status}`);

  // 2. Get client webhook config
  const { data: client } = await supabase
    .from('clients')
    .select('id, webhook_url, webhook_secret')
    .eq('id', request.client_id)
    .single();

  if (!client?.webhook_url) {
    console.error('No webhook URL configured for client');
    return;
  }

  console.log(`Webhook URL: ${client.webhook_url}\n`);

  // 3. Check existing deliveries for this request
  const { data: existingDeliveries } = await supabase
    .from('webhook_deliveries')
    .select('id, status, payload, last_status_code, last_error, attempts, created_at')
    .eq('request_id', request.id)
    .order('created_at', { ascending: true });

  console.log(`Existing deliveries: ${existingDeliveries?.length || 0}`);
  for (const d of (existingDeliveries || [])) {
    const p = d.payload as any;
    const fileInfo = p?.files?.[0]?.type || p?.record_type || p?.status || '?';
    console.log(`  ${d.id.slice(0, 8)} | ${d.status} | ${fileInfo} | HTTP ${d.last_status_code || '-'} | ${d.last_error?.slice(0, 60) || 'no error'} | attempts: ${d.attempts}`);
  }

  // 4. Get entity and transcript files
  const { data: entities } = await supabase
    .from('request_entities')
    .select('id, entity_name, form_type, transcript_urls, transcript_html_urls, tid, tid_kind')
    .eq('request_id', request.id);

  if (!entities || entities.length === 0) {
    console.error('No entities found');
    return;
  }

  console.log(`\nEntities: ${entities.length}`);

  // Collect all HTML files
  const htmlFiles: Array<{ entityId: string; entityName: string; formType: string; path: string }> = [];

  for (const entity of entities) {
    console.log(`  ${entity.entity_name} (${entity.tid}) — ${entity.form_type}`);

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

  // Deduplicate by path
  const seen = new Set<string>();
  const uniqueFiles = htmlFiles.filter(f => {
    if (seen.has(f.path)) return false;
    seen.add(f.path);
    return true;
  });

  console.log(`\nHTML files to send: ${uniqueFiles.length}`);

  if (uniqueFiles.length === 0) {
    console.error('No HTML files found — cannot send webhooks');
    return;
  }

  // 5. Enqueue incremental deliveries for each file
  let enqueued = 0;
  for (const file of uniqueFiles) {
    const filename = file.path.split('/').pop() || '';
    const cleanFilename = filename.replace(/^\d+-/, '');
    console.log(`\n  📤 ${cleanFilename}`);

    // Download HTML
    const { data: fileData, error: dlError } = await supabase.storage
      .from('uploads')
      .download(file.path);

    if (dlError || !fileData) {
      console.log(`    ❌ Download failed: ${dlError?.message}`);
      continue;
    }

    const htmlContent = await fileData.text();
    if (htmlContent.length < 100) {
      console.log(`    ❌ File too small (${htmlContent.length} chars)`);
      continue;
    }

    console.log(`    Size: ${(htmlContent.length / 1024).toFixed(1)}KB`);

    // Determine file type
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

    const hash = crypto.createHash('md5').update(`${file.entityId}:${file.path}`).digest('hex').slice(0, 12);
    const fileId = `mt_${hash}`;

    const payload = {
      request_token: REQUEST_TOKEN,
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
      console.log(`    ❌ Enqueue failed: ${insertError.message}`);
      continue;
    }

    console.log(`    ✅ Enqueued: ${delivery!.id.slice(0, 8)} (${fileType}, ${year || '?'})`);
    enqueued++;
  }

  // 6. Enqueue "complete" signal
  if (request.status === 'completed') {
    const completePayload = {
      request_token: REQUEST_TOKEN,
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
      console.log(`\n  📤 Enqueued "complete" signal: ${completeDel.id.slice(0, 8)}`);
      enqueued++;
    }
  }

  console.log(`\n=== ${enqueued} deliveries enqueued ===`);

  // 7. Deliver all pending for this request
  console.log('\nDelivering...\n');

  // Wake up Render
  console.log('Waking up ClearFirm endpoint...');
  try {
    await fetch(client.webhook_url, { method: 'HEAD' });
    await new Promise(r => setTimeout(r, 3000));
  } catch {
    await new Promise(r => setTimeout(r, 5000));
  }

  const { data: pendingDeliveries } = await supabase
    .from('webhook_deliveries')
    .select('id, payload')
    .eq('request_id', request.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  let delivered = 0;
  let failed = 0;

  for (const del of (pendingDeliveries || [])) {
    const payloadStr = JSON.stringify(del.payload);
    const now = new Date().toISOString();

    await supabase.from('webhook_deliveries').update({ status: 'sending' }).eq('id', del.id);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'ModernTax-Webhook/1.0',
      };

      if (client.webhook_secret) {
        headers['X-ModernTax-Signature'] = crypto
          .createHmac('sha256', client.webhook_secret)
          .update(payloadStr)
          .digest('hex');
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      const resp = await fetch(client.webhook_url, {
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
        const p = del.payload as any;
        const info = p?.files?.[0]?.type || p?.status || '?';
        console.log(`  ✅ ${del.id.slice(0, 8)} → ${info} (HTTP ${status})`);
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

    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Delivered: ${delivered}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${(pendingDeliveries || []).length}`);
}

main().catch(console.error);
