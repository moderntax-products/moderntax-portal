/**
 * Manually push the two completed Clearfirm entities to their webhook.
 *
 *   - OMT Addiction Centers LLC (entity 04ec6ff0..., request fcf7d347...,
 *     external_request_token CF-affinitifi-308)
 *   - Blue Peaks Roofing LLC   (entity 6844fd60..., request 082d4420...,
 *     external_request_token CF-affinitifi-307)
 *
 * Both are status='completed' with transcripts in storage but no
 * webhook_deliveries rows. The per-file + completion webhooks didn't
 * fire automatically (this matches the broader audit-log gap we saw
 * elsewhere — expert_transcript_uploaded events with file_count=0
 * even when files were actually present).
 *
 * For each entity:
 *   1. Fire triggerIncrementalWebhook() for every HTML file → Clearfirm
 *      gets one webhook per file with content + parsed metadata.
 *   2. Fire triggerWebhookForRequest() with the request id → Clearfirm
 *      gets a "request_token: ..., status: 'complete', files: []" signal
 *      meaning "all files delivered, nothing more coming."
 *
 * Webhook deliveries write to the webhook_deliveries table so retries
 * via /api/cron/webhook-retry pick up any failures automatically.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { triggerIncrementalWebhook, triggerWebhookForRequest } from '@/lib/webhook';

const TARGETS = [
  { entity_id: '04ec6ff0-387b-45d0-8f03-0d01047d6a31', label: 'OMT Addiction Centers LLC' },
  { entity_id: '6844fd60-6dfb-4a56-9a8c-c36b97a9b860', label: 'Blue Peaks Roofing LLC' },
];

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  for (const t of TARGETS) {
    console.log(`\n=== ${t.label} (${t.entity_id}) ===`);

    const { data: e } = await supabase
      .from('request_entities')
      .select('id, entity_name, form_type, request_id, transcript_urls, transcript_html_urls, status')
      .eq('id', t.entity_id)
      .single() as { data: any | null };
    if (!e) { console.log('  entity not found'); continue; }

    // The schema has the two arrays reversed in practice — transcript_urls
    // currently holds the .html paths and transcript_html_urls holds the
    // .pdf paths. Take the union and filter to actual .html for the
    // incremental webhook (Clearfirm gets HTML for parsing).
    const urls: string[] = Array.from(new Set([
      ...(e.transcript_urls || []),
      ...(e.transcript_html_urls || []),
    ]));
    const htmlUrls = urls.filter(u => u.endsWith('.html') || u.endsWith('.htm'));
    console.log(`  status:    ${e.status}`);
    console.log(`  form_type: ${e.form_type}`);
    console.log(`  request_id: ${e.request_id}`);
    console.log(`  HTML files: ${htmlUrls.length}`);

    let firedIncremental = 0;
    for (const url of htmlUrls) {
      try {
        await triggerIncrementalWebhook(
          supabase as any,
          e.request_id,
          e.id,
          e.entity_name,
          e.form_type || '',
          url,
        );
        firedIncremental++;
        console.log(`    ✓ incremental webhook enqueued for ${url.split('/').pop()}`);
      } catch (err) {
        console.error(`    ✗ incremental webhook failed for ${url}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Final "request complete" signal
    try {
      const id = await triggerWebhookForRequest(supabase as any, e.request_id);
      console.log(`  ✓ completion webhook enqueued: ${id || '(no delivery — likely intake_method != api or no token)'}`);
    } catch (err) {
      console.error(`  ✗ completion webhook failed: ${err instanceof Error ? err.message : err}`);
    }

    console.log(`  → ${firedIncremental} file webhooks fired + 1 completion`);
  }

  // Show fresh webhook_deliveries
  const requestIds: string[] = [];
  for (const t of TARGETS) {
    const { data: e } = await supabase
      .from('request_entities')
      .select('request_id')
      .eq('id', t.entity_id)
      .single() as { data: any };
    if (e?.request_id) requestIds.push(e.request_id);
  }
  const { data: deliveries } = await supabase
    .from('webhook_deliveries')
    .select('id, request_id, status, attempts, last_response_status, last_error')
    .in('request_id', requestIds)
    .order('created_at', { ascending: true }) as { data: any[] | null };

  console.log(`\n=== webhook_deliveries after push: ${deliveries?.length || 0} rows ===`);
  const byRequest = new Map<string, any[]>();
  for (const d of deliveries || []) {
    (byRequest.get(d.request_id) || byRequest.set(d.request_id, []).get(d.request_id)!).push(d);
  }
  for (const [rid, ds] of byRequest.entries()) {
    console.log(`\n  request ${rid}: ${ds.length} deliveries`);
    for (const d of ds) {
      console.log(`    ${d.status.padEnd(10)} attempts=${d.attempts}  resp=${d.last_response_status || '—'}  err=${(d.last_error || '').slice(0, 80)}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
