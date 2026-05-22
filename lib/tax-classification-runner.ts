/**
 * runTaxClassificationDetection(entityId)
 *
 * Loads an entity + its transcripts + its 2553 status, runs the detector,
 * persists the result to request_entities.tax_classification_mismatch, and
 * returns the full structured response the admin panel renders.
 *
 * Re-runnable safely — overwrites the persisted mismatch on every call.
 */

import { createAdminClient } from '@/lib/supabase-server';
import {
  detectTaxClassificationMismatch,
  parseBmfEntity,
  parseTranscriptHeader,
  buildBorrowerCommunication,
  formatMismatchForUI,
  type Form2553Status,
  type TaxClassificationMismatch,
} from '@/lib/tax-classification';

export type { Form2553Status, TaxClassificationMismatch };

export interface TaxClassificationDetectionResult {
  entity_id: string;
  entity_name: string;
  declared_form: string;
  irs_form: string | null;
  check_requested: boolean;
  form_2553_status: Form2553Status | null;
  mismatch: TaxClassificationMismatch | null;
  ui_block: ReturnType<typeof formatMismatchForUI> | null;
  borrower_communication: { subject: string; body: string } | null;
  bmf_entity_present: boolean;
  recent_transcript_was_stub: boolean;
}

export async function runTaxClassificationDetection(entityId: string): Promise<TaxClassificationDetectionResult> {
  const sb = createAdminClient();

  // Load entity + client (for borrower comm lender name)
  const { data: ent } = await sb.from('request_entities')
    .select('id, entity_name, tid, form_type, years, status, transcript_urls, transcript_html_urls, tax_classification_check_requested, form_2553_status, requests(loan_number, clients(name))')
    .eq('id', entityId).single() as { data: any };
  if (!ent) {
    throw new Error(`Entity ${entityId} not found`);
  }

  const allUrls: string[] = Array.from(new Set([
    ...((ent.transcript_urls as string[]) || []),
    ...((ent.transcript_html_urls as string[]) || []),
  ]));

  // Find BMF Entity transcript (filename hint: "bmf_entity" or "Entity Transcript")
  const bmfUrl = allUrls.find((u: string) =>
    /bmf[_\-]?entity|entity[_\-]?transcript/i.test(u.split('/').pop() || '')
  );

  // Find the MOST RECENT year's Account Transcript (HTML preferred for parsing)
  const requestedYears: string[] = (ent.years || []).map(String);
  const mostRecentYear = requestedYears.slice().sort().reverse()[0] || null;
  let recentUrl: string | undefined;
  if (mostRecentYear) {
    // Prefer HTML for the most recent year
    recentUrl = allUrls.find((u: string) =>
      u.endsWith('.html') && u.includes(mostRecentYear) && /Account Transcript/i.test(u)
    ) || allUrls.find((u: string) => u.includes(mostRecentYear) && /Account Transcript/i.test(u));
  }

  // Download + parse
  let bmf = null;
  if (bmfUrl) {
    const { data: f } = await sb.storage.from('uploads').download(bmfUrl);
    if (f) {
      const buf = Buffer.from(await f.arrayBuffer());
      if (bmfUrl.endsWith('.html')) {
        bmf = parseBmfEntity(buf.toString('utf8'));
      }
    }
  }

  let recent = null;
  if (recentUrl) {
    const { data: f } = await sb.storage.from('uploads').download(recentUrl);
    if (f) {
      const buf = Buffer.from(await f.arrayBuffer());
      if (recentUrl.endsWith('.html')) {
        recent = parseTranscriptHeader(buf.toString('utf8'), recentUrl.split('/').pop() || '');
      } else if (recentUrl.endsWith('.pdf')) {
        const pdfParse = (await import('pdf-parse')).default;
        try {
          const text = (await pdfParse(buf)).text;
          recent = parseTranscriptHeader(`<html><body>${text}</body></html>`, recentUrl.split('/').pop() || '');
        } catch {
          // pdf-parse failure is non-fatal — leave recent as null
        }
      }
    }
  }

  const mismatch = detectTaxClassificationMismatch({
    declared_form: ent.form_type || '',
    bmf_entity: bmf,
    recent_transcript: recent,
    form_2553_status: ent.form_2553_status || null,
    // If the borrower's intake had any year that's now showing as a stub,
    // we treat the most-recent year as the "claimed filed" year.
    borrower_claims_filed_year: recent?.isStubResponse && mostRecentYear ? parseInt(mostRecentYear, 10) : null,
  });

  // Persist the result so the admin panel can load it without re-running.
  await (sb.from('request_entities') as any).update({
    tax_classification_mismatch: mismatch,
  }).eq('id', entityId);

  const lenderName = ent.requests?.clients?.name || null;
  const ui_block = mismatch ? formatMismatchForUI(mismatch) : null;
  const borrower_communication = mismatch
    ? buildBorrowerCommunication({
        entity_name: ent.entity_name,
        tin: ent.tid,
        mismatch,
        form_2553_status: ent.form_2553_status,
        lender_name: lenderName,
      })
    : null;

  return {
    entity_id: ent.id,
    entity_name: ent.entity_name,
    declared_form: ent.form_type || '',
    irs_form: mismatch?.irs_form || null,
    check_requested: !!ent.tax_classification_check_requested,
    form_2553_status: ent.form_2553_status || null,
    mismatch,
    ui_block,
    borrower_communication,
    bmf_entity_present: !!bmf,
    recent_transcript_was_stub: !!recent?.isStubResponse,
  };
}
