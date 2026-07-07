/**
 * Auto-fulfill a request from records already on file.
 *
 * ModernTax is the transcript utility: if we've already pulled an entity's
 * transcripts (matched by TIN, across any prior request/client), a new request
 * for that same entity shouldn't wait in the IRS queue — we copy the records
 * onto it and deliver them immediately.
 *
 * This is the single source of truth used by BOTH:
 *   - intake time (/api/intake/transcript) — fires as the request is created, and
 *   - the self-healing sweep (/api/cron/auto-fulfill-from-record) — catches any
 *     request already sitting in the DB whose entities now match a record on
 *     file (e.g. it was queued before the source pull finished, or predates this
 *     feature).
 *
 * For API-intake requests the copied transcripts are delivered to the partner
 * via the same incremental webhooks an expert upload fires; when the WHOLE
 * request is served from record it's marked completed and the terminal
 * "complete" signal is sent. Portal-intake requests are simply attached +
 * completed (the processor sees them in the portal). Best-effort throughout —
 * a delivery failure is retried by the webhook-retry cron and never aborts the
 * rest.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { findPriorEntities, attachPriorTranscripts } from './repeat-entity';
import { triggerIncrementalWebhook, triggerWebhookForRequest } from './webhook';

export interface AutoFulfillServed {
  entityId: string;
  entityName: string;
  priorLoan: string;
  transcripts: number;
}

export interface AutoFulfillResult {
  served: AutoFulfillServed[];
  requestCompleted: boolean;
}

/**
 * Detect + fulfill every not-yet-fulfilled entity on a request from records on
 * file. Safe to call repeatedly (idempotent: entities that already have
 * transcripts are skipped).
 */
export async function autoFulfillRequestFromRecord(
  supabase: SupabaseClient,
  requestId: string,
): Promise<AutoFulfillResult> {
  const served: AutoFulfillServed[] = [];

  const { data: req } = await supabase
    .from('requests')
    .select('id, intake_method, external_request_token, status')
    .eq('id', requestId)
    .single() as { data: any };
  if (!req) return { served, requestCompleted: false };

  // Monitoring re-pulls exist specifically to fetch FRESH IRS data (e.g. a
  // newly-filed year, or changes to a filed year). They must never be served
  // from cached transcripts — that would deliver stale data and defeat the
  // service. Skip the whole request if it's a monitoring re-pull.
  if (req.intake_method === 'monitoring_repull') {
    return { served, requestCompleted: false };
  }

  const isApi = req.intake_method === 'api' && !!req.external_request_token;

  const { data: entities } = await supabase
    .from('request_entities')
    .select('id, entity_name, tid, form_type, status, transcript_urls, transcript_html_urls, gross_receipts')
    .eq('request_id', requestId) as { data: any[] | null };
  if (!entities || entities.length === 0) return { served, requestCompleted: false };

  for (const ent of entities) {
    // Belt-and-suspenders: also skip any entity individually tagged as a
    // monitoring re-pull (e.g. created under a different intake_method because
    // the 'monitoring_repull' value is blocked by the requests CHECK constraint).
    if (ent.gross_receipts?.monitoring_repull === true) continue;
    const already = ((ent.transcript_urls || []).length + (ent.transcript_html_urls || []).length) > 0;
    if (already || ent.status === 'completed') continue; // already fulfilled

    const priors = await findPriorEntities(supabase, ent.tid, ent.id);
    const prior = priors.find((p) => p.transcriptCount > 0);
    if (!prior) continue;

    const attached = await attachPriorTranscripts(supabase, ent.id, prior);
    if (!attached) continue;

    // Deliver each cached HTML transcript to the partner incrementally, exactly
    // as an expert upload would. API-intake only; portal requests just complete.
    if (isApi) {
      for (const htmlPath of prior.transcriptHtmlUrls) {
        try {
          await triggerIncrementalWebhook(supabase, requestId, ent.id, ent.entity_name, ent.form_type, htmlPath);
        } catch (whErr) {
          console.error(`[auto-fulfill] incremental webhook failed for ${ent.id} (${htmlPath}):`, whErr);
        }
      }
    }

    served.push({ entityId: ent.id, entityName: ent.entity_name, priorLoan: prior.loanNumber, transcripts: prior.transcriptCount });
    console.log(`[auto-fulfill] ${ent.entity_name} (TIN ${ent.tid}) served from prior loan ${prior.loanNumber} — ${prior.transcriptCount} transcript(s)`);
  }

  if (served.length === 0) return { served, requestCompleted: false };

  // Complete the request iff EVERY entity on it is now completed (some may have
  // been completed on a prior run or by an expert).
  const { data: fresh } = await supabase
    .from('request_entities')
    .select('status')
    .eq('request_id', requestId) as { data: any[] | null };
  const allDone = !!fresh && fresh.length > 0 && fresh.every((e) => e.status === 'completed');

  if (allDone && req.status !== 'completed') {
    await (supabase.from('requests') as any)
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', requestId);
    if (isApi) {
      try {
        await triggerWebhookForRequest(supabase, requestId);
      } catch (whErr) {
        console.error(`[auto-fulfill] completion webhook failed for ${requestId}:`, whErr);
      }
    }
    console.log(`[auto-fulfill] Request ${requestId} fully served from record (${served.length} entities this pass) — completed`);
  }

  return { served, requestCompleted: allDone };
}
