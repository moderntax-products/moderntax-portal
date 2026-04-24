/**
 * Re-fire CF-cherrytech-271 webhooks after the token-mismatch fix.
 *
 * Context: 13 prior deliveries for this entity went out under token
 * `CF-clearfirm-271` and all 404'd at ClearFirm. We moved the completed entity
 * onto the correct `CF-cherrytech-271` request; this script now fires the
 * per-HTML incrementals + terminal complete webhook so ClearFirm can ingest.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { triggerIncrementalWebhook, triggerWebhookForRequest } from '@/lib/webhook';

dotenv.config({ path: '.env.local' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
);

const GOOD_REQ = 'de852f58-2f18-434e-b45f-322d5b6fce1d';
const GOOD_ENT = '99d52e42-2eb9-4001-8e87-83e860263678';

(async () => {
  const { data: entity } = await supabase
    .from('request_entities')
    .select('id, entity_name, form_type, transcript_html_urls, transcript_urls')
    .eq('id', GOOD_ENT)
    .single();
  if (!entity) { console.error('entity not found'); process.exit(1); }

  const htmls: string[] = (entity as any).transcript_html_urls || [];
  console.log(`Firing webhooks for ${(entity as any).entity_name} (${htmls.length} HTML files)`);

  let fired = 0;
  for (const htmlPath of htmls) {
    try {
      const deliveryId = await triggerIncrementalWebhook(
        supabase as any,
        GOOD_REQ,
        (entity as any).id,
        (entity as any).entity_name,
        (entity as any).form_type || '1040',
        htmlPath,
      );
      if (deliveryId) {
        fired++;
        console.log(`  ✅ ${htmlPath.split('/').pop()?.slice(0, 55)} → delivery ${deliveryId.slice(0, 8)}`);
      } else {
        console.log(`  ⚠️  ${htmlPath.split('/').pop()?.slice(0, 55)} → skipped`);
      }
    } catch (e: any) {
      console.log(`  ❌ ${htmlPath.split('/').pop()?.slice(0, 55)} → ${e.message}`);
    }
  }
  console.log(`\nFired ${fired}/${htmls.length} incremental webhooks`);

  console.log('\nFiring terminal complete webhook…');
  try {
    const result = await triggerWebhookForRequest(supabase as any, GOOD_REQ, 'request.completed' as any);
    console.log(`  → ${JSON.stringify(result)}`);
  } catch (e: any) {
    console.log(`  ❌ ${e.message}`);
  }

  const { data: ds } = await supabase
    .from('webhook_deliveries')
    .select('status, payload, last_status_code, last_error')
    .eq('request_id', GOOD_REQ)
    .order('created_at', { ascending: false })
    .limit(15);
  console.log(`\n=== Post-fire deliveries (last ${ds?.length}) ===`);
  for (const d of ds || []) {
    const p: any = (d as any).payload;
    const tok = p?.request_token;
    const pStatus = p?.status;
    const err: string | null = (d as any).last_error;
    console.log(`  ${(d as any).status.padEnd(10)} ${(pStatus || '-').padEnd(8)} resp=${(d as any).last_status_code || '-'} token=${tok}${err ? ` err: ${err.slice(0, 100)}` : ''}`);
  }
})();
