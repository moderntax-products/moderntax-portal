/**
 * Centerstone transcript HTML → PDF auto-converter (2026-06-29).
 *
 * Matt: "all HTMLs for Centerstone processors should be auto-converted to PDF."
 * Centerstone processors download transcripts as files; if a raw .html lands in
 * the download slot (transcript_urls) it renders as code in their viewer. This
 * cron finds any such entity, renders the HTML to PDF server-side, swaps the PDF
 * into the download slot, and preserves the HTML in transcript_html_urls.
 *
 * Catch-all by design: covers every ingest path (expert upload, webhook, scripts).
 * Idempotent + bounded. Early-exits BEFORE launching Chromium when there's no
 * work, so empty runs are cheap.
 *
 * GET /api/cron/centerstone-html-to-pdf — Auth: Vercel cron Bearer secret.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';

export const maxDuration = 60;
export const runtime = 'nodejs';

const CENTERSTONE_CLIENT_ID = '60f80d60-03ad-42d7-95da-c0f1cd311523';
const MAX_FILES_PER_RUN = 12; // Chromium renders are ~1-3s each; stay under maxDuration

const baseName = (p: string) =>
  (p.split('/').pop() || '').replace(/\.(html?|pdf)$/i, '').replace(/^\d+-/, '');

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();

  // 1. Cheap scan first — find Centerstone entities with .html in the download slot.
  const { data: ents } = await admin.from('request_entities')
    .select('id, entity_name, transcript_urls, transcript_html_urls, requests!inner(client_id)')
    .eq('requests.client_id', CENTERSTONE_CLIENT_ID) as { data: any[] | null };

  const targets = (ents || [])
    .map((e) => ({ ...e, htmlInSlot: (e.transcript_urls || []).filter((u: string) => /\.html?$/i.test(u)) }))
    .filter((e) => e.htmlInSlot.length > 0);

  if (targets.length === 0) {
    return NextResponse.json({ success: true, converted: 0, entities: 0, note: 'no HTML in any Centerstone download slot' });
  }

  // 2. Only now pull in the heavy renderer.
  const { renderHtmlToPdf } = await import('@/lib/html-to-pdf');

  const log: any[] = [];
  let converted = 0;
  let entitiesFixed = 0;

  for (const e of targets) {
    if (converted >= MAX_FILES_PER_RUN) break;
    const pdfsInSlot: string[] = (e.transcript_urls || []).filter((u: string) => /\.pdf$/i.test(u));
    const pdfBases = new Set(pdfsInSlot.map(baseName));
    const newPdfs = [...pdfsInSlot];
    let changed = false;

    for (const h of e.htmlInSlot) {
      if (converted >= MAX_FILES_PER_RUN) break;
      if (pdfBases.has(baseName(h))) { changed = true; continue; } // already has a PDF twin → just move HTML out
      try {
        const { data: blob, error } = await admin.storage.from('uploads').download(h);
        if (error || !blob) { log.push({ entity: e.entity_name, file: h, status: 'download_failed', detail: error?.message }); continue; }
        const htmlStr = await blob.text();
        const pdfBuf = await renderHtmlToPdf(htmlStr);
        const path = `transcripts/${e.id}/${Date.now()}-${baseName(h)}.pdf`;
        const up = await admin.storage.from('uploads').upload(path, pdfBuf, { contentType: 'application/pdf', upsert: true });
        if (up.error) { log.push({ entity: e.entity_name, file: h, status: 'upload_failed', detail: up.error.message }); continue; }
        newPdfs.push(path);
        converted++;
        changed = true;
        log.push({ entity: e.entity_name, file: baseName(h), status: 'converted', bytes: pdfBuf.length });
      } catch (err: any) {
        log.push({ entity: e.entity_name, file: h, status: 'render_failed', detail: err?.message });
      }
    }

    if (changed) {
      const newHtml = [...new Set([...(e.transcript_html_urls || []), ...e.htmlInSlot])];
      const { error: upErr } = await admin.from('request_entities')
        .update({ transcript_urls: newPdfs, transcript_html_urls: newHtml }).eq('id', e.id);
      if (upErr) { log.push({ entity: e.entity_name, status: 'entity_update_failed', detail: upErr.message }); }
      else entitiesFixed++;
    }
  }

  if (log.length) console.log('[centerstone-html-to-pdf]\n' + JSON.stringify(log, null, 2));

  return NextResponse.json({
    success: true,
    entities_with_html: targets.length,
    entities_fixed: entitiesFixed,
    converted,
    truncated: converted >= MAX_FILES_PER_RUN,
    actions: log,
  });
}
