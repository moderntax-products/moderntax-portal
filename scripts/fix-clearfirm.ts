import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load production env vars
dotenv.config({ path: path.resolve(__dirname, '../.env.vercel-prod') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  // ====== STEP 1: Remove Thomas Evers' files from INFINITY MEDSPA (request 272) ======
  const infinityEntityId = 'fa1ec29c-1b28-409c-9a43-0d35670d74fa';
  
  const { data: infinityEntity } = await supabase
    .from('request_entities')
    .select('transcript_urls, transcript_html_urls')
    .eq('id', infinityEntityId)
    .single();

  console.log('=== INFINITY MEDSPA FILES (BEFORE) ===');
  console.log('transcript_urls:', infinityEntity?.transcript_urls);
  console.log('transcript_html_urls:', infinityEntity?.transcript_html_urls);

  // Remove files that belong to Thomas Evers (contain "THOM B EVER")
  const cleanUrls = (infinityEntity?.transcript_urls || []).filter(
    (url: string) => !url.includes('THOM B EVER')
  );
  const cleanHtmlUrls = (infinityEntity?.transcript_html_urls || []).filter(
    (url: string) => !url.includes('THOM B EVER')
  );

  console.log('\n=== INFINITY MEDSPA FILES (AFTER CLEANUP) ===');
  console.log('transcript_urls:', cleanUrls);
  console.log('transcript_html_urls:', cleanHtmlUrls);

  const { error: infinityErr } = await supabase
    .from('request_entities')
    .update({ transcript_urls: cleanUrls, transcript_html_urls: cleanHtmlUrls })
    .eq('id', infinityEntityId);

  if (infinityErr) console.error('Failed to clean INFINITY MEDSPA:', infinityErr);
  else console.log('✅ Cleaned INFINITY MEDSPA — removed Thomas Evers files');

  // ====== STEP 2: Fix Request 269 webhook (stuck in "sending") ======
  const { data: stuckDelivery } = await supabase
    .from('webhook_deliveries')
    .select('id')
    .eq('request_id', 'b627c335-9368-4e5b-b6cf-d0b741e1fb99')
    .eq('status', 'sending')
    .single();

  if (stuckDelivery) {
    await supabase
      .from('webhook_deliveries')
      .update({ status: 'failed', last_error: 'Stuck in sending — reset for retry', next_retry_at: new Date().toISOString() })
      .eq('id', stuckDelivery.id);
    console.log(`\n✅ Reset stuck delivery ${stuckDelivery.id} to failed for retry`);
  }

  // ====== STEP 3: Reset failed deliveries for 272 for retry ======
  const { data: failedDeliveries } = await supabase
    .from('webhook_deliveries')
    .select('id')
    .eq('request_id', 'd30578ab-7cb3-4394-81ec-aea005544f2f')
    .eq('status', 'failed');

  for (const d of (failedDeliveries || [])) {
    await supabase
      .from('webhook_deliveries')
      .update({ status: 'pending', attempts: 0, next_retry_at: new Date().toISOString(), last_error: null })
      .eq('id', d.id);
    console.log(`✅ Reset delivery ${d.id} for retry`);
  }

  // ====== STEP 4: Check what HTML files exist for request 270 (Thomas Evers) ======
  const eversEntityId = 'ddab72e1-2d54-4edf-b42e-b3ebb5748f73';
  const { data: eversEntity } = await supabase
    .from('request_entities')
    .select('transcript_urls, transcript_html_urls, form_type')
    .eq('id', eversEntityId)
    .single();

  console.log('\n=== THOMAS EVERS FILES ===');
  console.log('Form type:', eversEntity?.form_type);
  console.log('transcript_urls (primary/HTML):', (eversEntity?.transcript_urls || []).length, 'files');
  for (const url of (eversEntity?.transcript_urls || [])) {
    const name = url.split('/').pop()?.replace(/^\d+-/, '') || url;
    console.log(`  ${name}`);
  }
  console.log('transcript_html_urls (secondary/PDF):', (eversEntity?.transcript_html_urls || []).length, 'files');

  // ====== STEP 5: Check what 269 (Lawrence Ebel) needs ======
  const ebelEntityId = 'd0d40f18-87e8-4741-8fc0-19d788ccb34d';
  const { data: ebelEntity } = await supabase
    .from('request_entities')
    .select('transcript_urls, transcript_html_urls, form_type, status')
    .eq('id', ebelEntityId)
    .single();

  console.log('\n=== LAWRENCE EBEL FILES ===');
  console.log('Form type:', ebelEntity?.form_type);
  console.log('Status:', ebelEntity?.status);
  console.log('transcript_urls:', ebelEntity?.transcript_urls);
  console.log('transcript_html_urls:', ebelEntity?.transcript_html_urls);
  console.log('NOTE: Only PDFs — no HTML files. The bookmarklet v6.1 pre-HTML-upload captured these.');

  console.log('\n=== RECONCILIATION SUMMARY ===');
  console.log('1. ✅ Removed Thomas Evers files from INFINITY MEDSPA');
  console.log('2. ✅ Reset stuck webhook for 269 (Lawrence Ebel)');
  console.log('3. ✅ Reset failed webhooks for 272 (INFINITY MEDSPA)');
  console.log('4. 270 (Thomas Evers) has correct files + some 1065 series that may be legitimate supplemental');
  console.log('5. 269 (Lawrence Ebel) only has PDFs — needs re-upload with HTML when available');
  console.log('\nNEXT: Trigger webhook-retry cron to re-deliver pending/failed webhooks');
}

main().catch(console.error);
