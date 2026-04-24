/**
 * Re-fire webhooks for CF-cherrytech-297 (Raio Dental P.C.) and
 * CF-affinitifi-300 (The Water Heater & Plumbing Company).
 *
 * Uses the same heal-then-fire pattern as refire-all-clearfirm.ts:
 *   1. Detect and correct any PDF/HTML array swap
 *   2. Fire an incremental webhook for each HTML transcript
 *   3. Fire the terminal request.completed webhook
 *   4. Summarise the last 25 delivery rows so we can see delivered/failed
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { triggerIncrementalWebhook, triggerWebhookForRequest } from '@/lib/webhook';

dotenv.config({ path: '.env.local' });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
);

interface Target { label: string; requestId: string; }

const TARGETS: Target[] = [
  { label: '297 Raio Dental P.C. (cherrytech)',              requestId: '19b8737b-7264-4bf4-b5c5-5a955ee513c5' },
  { label: '300 The Water Heater & Plumbing Co (affinitifi)', requestId: '11e9df60-4106-4bae-92c2-14de196aab99' },
];

async function classifyStorage(path: string): Promise<'PDF' | 'HTML' | 'OTHER'> {
  const { data } = await supabase.storage.from('uploads').download(path);
  if (!data) return 'OTHER';
  const buf = Buffer.from(await data.arrayBuffer());
  const header = buf.slice(0, 8).toString('ascii');
  if (header.startsWith('%PDF-')) return 'PDF';
  if (header.trimStart().startsWith('<')) return 'HTML';
  return 'OTHER';
}

async function fixSwappedArrays(entityId: string, pdfs: string[] | null, htmls: string[] | null) {
  const firstPdf = (pdfs || [])[0];
  const firstHtml = (htmls || [])[0];
  if (!firstPdf && !firstHtml) return { swapped: false, reason: 'no files' };

  const actualOfPdfCol = firstPdf ? await classifyStorage(firstPdf) : null;
  const actualOfHtmlCol = firstHtml ? await classifyStorage(firstHtml) : null;

  const needsSwap = actualOfPdfCol === 'HTML' && actualOfHtmlCol === 'PDF';
  if (!needsSwap) return { swapped: false, reason: `no swap needed (pdf_col=${actualOfPdfCol}, html_col=${actualOfHtmlCol})` };

  await supabase
    .from('request_entities')
    .update({
      transcript_urls: htmls,
      transcript_html_urls: pdfs,
    })
    .eq('id', entityId);

  return { swapped: true, reason: 'arrays swapped' };
}

(async () => {
  for (const t of TARGETS) {
    console.log(`\n═══ ${t.label} ═══`);

    const { data: req } = await supabase
      .from('requests')
      .select('id, external_request_token, intake_method, status')
      .eq('id', t.requestId)
      .single();
    if (!req) { console.log('  ❌ request not found'); continue; }
    console.log(`  token=${(req as any).external_request_token} status=${(req as any).status}`);

    const { data: ents } = await supabase
      .from('request_entities')
      .select('id, entity_name, form_type, transcript_urls, transcript_html_urls, status')
      .eq('request_id', t.requestId)
      .not('status', 'eq', 'cancelled');

    for (const e of (ents || []) as any[]) {
      console.log(`\n  Entity ${e.id.slice(0,8)} "${e.entity_name}"`);

      const heal = await fixSwappedArrays(e.id, e.transcript_urls, e.transcript_html_urls);
      console.log(`    heal: ${heal.reason}`);

      const { data: fresh } = await supabase
        .from('request_entities')
        .select('form_type, transcript_html_urls')
        .eq('id', e.id)
        .single();
      const htmls: string[] = (fresh as any)?.transcript_html_urls || [];
      const formType: string = (fresh as any)?.form_type || '1040';

      let fired = 0, skipped = 0;
      for (const htmlPath of htmls) {
        try {
          const deliveryId = await triggerIncrementalWebhook(
            supabase as any,
            t.requestId,
            e.id,
            e.entity_name,
            formType,
            htmlPath,
          );
          if (deliveryId) fired++;
          else skipped++;
        } catch (err: any) {
          console.log(`    ❌ ${htmlPath.split('/').pop()?.slice(0, 45)} → ${err.message}`);
          skipped++;
        }
      }
      console.log(`    incremental: ${fired}/${htmls.length} fired (skipped=${skipped})`);
    }

    try {
      const complete = await triggerWebhookForRequest(supabase as any, t.requestId, 'request.completed' as any);
      console.log(`  complete webhook → ${JSON.stringify(complete)}`);
    } catch (err: any) {
      console.log(`  ❌ complete webhook failed: ${err.message}`);
    }

    const { data: deliveries } = await supabase
      .from('webhook_deliveries')
      .select('status, last_status_code, created_at')
      .eq('request_id', t.requestId)
      .order('created_at', { ascending: false })
      .limit(25);
    const recent = deliveries || [];
    const delivered = recent.filter((d: any) => d.status === 'delivered').length;
    const failed = recent.filter((d: any) => ['failed', 'dead'].includes(d.status)).length;
    console.log(`  recent (last ${recent.length}): delivered=${delivered} failed=${failed}`);
  }
})();
