/**
 * Shared processor-summary generation — parse an entity's transcripts, build the
 * plain-language summary, and persist it. Used by both the on-demand route
 * (/api/entity/[id]/processor-summary) and the resummarize-notify cron, so
 * there's one source of truth for how a summary is produced.
 *
 * Matt 2026-07-30.
 */

import { buildTaxLiabilityReport } from '@/lib/tax-liability-report';
import { buildProcessorSummary, coverageFromFilenames, type ProcessorSummary } from '@/lib/processor-summary';

export interface RegenResult {
  ok: boolean;
  error?: string;
  summary?: ProcessorSummary;
  entity?: any;
}

/**
 * Re-parse the entity's HTML transcripts, rebuild the summary, store it on
 * gross_receipts.processor_summary, and clear any `summary_stale` flag.
 * `admin` is a service-role Supabase client.
 */
export async function regenerateProcessorSummary(admin: any, entityId: string): Promise<RegenResult> {
  const { data: entity } = await admin.from('request_entities')
    .select('id, entity_name, tid, gross_receipts, transcript_urls, transcript_html_urls, ' +
      'requests!inner ( id, client_id, requested_by, loan_number, profiles:requested_by ( email, full_name ), clients ( name ) )')
    .eq('id', entityId).single() as { data: any };
  if (!entity) return { ok: false, error: 'Entity not found' };

  const htmlUrls: string[] = Array.from(new Set(
    [...(entity.transcript_html_urls || []), ...(entity.transcript_urls || [])]
      .filter((u: string) => u.toLowerCase().endsWith('.html')),
  ));
  if (htmlUrls.length === 0) return { ok: false, error: 'No parseable (HTML) transcripts', entity };

  const transcripts: { source: string; html: string }[] = [];
  for (const u of htmlUrls) {
    const { data: file } = await admin.storage.from('uploads').download(u);
    if (file) transcripts.push({ source: u.split('/').pop() || u, html: await file.text() });
  }
  if (transcripts.length === 0) return { ok: false, error: 'Could not read transcripts', entity };

  const report = buildTaxLiabilityReport(entity.entity_name, entity.tid, transcripts);
  const coverage = coverageFromFilenames([...(entity.transcript_urls || []), ...(entity.transcript_html_urls || [])]);
  const summary = buildProcessorSummary(report, coverage, new Date().toISOString());

  const gr = { ...(entity.gross_receipts || {}), processor_summary: summary };
  delete gr.summary_stale; // regenerating clears the "new files arrived" flag
  const { error: upErr } = await admin.from('request_entities').update({ gross_receipts: gr }).eq('id', entityId);
  if (upErr) return { ok: false, error: upErr.message, entity };

  return { ok: true, summary, entity };
}
