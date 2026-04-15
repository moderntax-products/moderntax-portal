/**
 * Repeat Entity Intelligence
 *
 * Detects when a new request contains an entity (matched by TID) that was
 * previously verified. Auto-attaches prior transcripts, skips 8821 if
 * recently signed, and auto-enrolls in monitoring.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PriorEntityInfo {
  entityId: string;
  entityName: string;
  requestId: string;
  loanNumber: string;
  completedAt: string;
  transcriptUrls: string[];
  transcriptHtmlUrls: string[];
  signedEightyTwentyOneUrl: string | null;
  signatureCreatedAt: string | null;
  grossReceipts: Record<string, any> | null;
  transcriptCount: number;
  complianceSummary: string;
}

export interface RepeatEntityMatch {
  entityId: string;
  entityName: string;
  priorLoan: string;
  priorCompletedAt: string;
  transcriptsAttached: number;
  complianceSummary: string;
  monitoringEnrolled: boolean;
  eightyTwentyOneSkipped: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Skip 8821 if a signed one exists within this many days */
const SIGNED_8821_VALID_DAYS = 120;

const MONITORING_ENROLLMENT_FEE = 19.99;
const MONITORING_PER_PULL_FEE = 39.99;

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Find prior entities with the same TID that have completed transcripts.
 * Returns matches ordered by most recent first.
 */
export async function findPriorEntities(
  supabase: SupabaseClient,
  tid: string,
  excludeEntityId: string
): Promise<PriorEntityInfo[]> {
  const cleanTid = tid.replace(/-/g, '');
  if (!cleanTid || cleanTid.length < 4) return [];

  const { data: matches } = await supabase
    .from('request_entities')
    .select(`
      id, entity_name, request_id, status, transcript_urls, transcript_html_urls,
      signed_8821_url, signature_created_at, gross_receipts,
      requests!inner(loan_number, created_at)
    `)
    .eq('tid', cleanTid)
    .neq('id', excludeEntityId)
    .in('status', ['completed', 'irs_queue', 'processing', '8821_signed'])
    .order('created_at', { ascending: false }) as { data: any[] | null; error: any };

  if (!matches || matches.length === 0) return [];

  return matches
    .filter((m: any) => {
      // Must have at least one transcript
      const urls = [...(m.transcript_urls || []), ...(m.transcript_html_urls || [])];
      return urls.length > 0;
    })
    .map((m: any) => {
      const transcriptUrls = m.transcript_urls || [];
      const transcriptHtmlUrls = m.transcript_html_urls || [];
      const totalTranscripts = transcriptUrls.length + transcriptHtmlUrls.length;

      // Summarize compliance from gross_receipts
      let complianceSummary = 'CLEAN — no flags';
      if (m.gross_receipts) {
        const allFlags: string[] = [];
        for (const [key, val] of Object.entries(m.gross_receipts)) {
          if (key === 'entity_transcript' || key === 'entity_transcript_order') continue;
          const entry = val as any;
          if (entry?.severity === 'CRITICAL' || entry?.severity === 'WARNING') {
            const flagCount = entry.flags?.length || 0;
            allFlags.push(`${entry.severity}: ${flagCount} flag(s) in ${key}`);
          }
        }
        if (allFlags.length > 0) {
          complianceSummary = allFlags.join('; ');
        }
      }

      return {
        entityId: m.id,
        entityName: m.entity_name,
        requestId: m.request_id,
        loanNumber: m.requests?.loan_number || 'N/A',
        completedAt: m.requests?.created_at || '',
        transcriptUrls,
        transcriptHtmlUrls,
        signedEightyTwentyOneUrl: m.signed_8821_url,
        signatureCreatedAt: m.signature_created_at,
        grossReceipts: m.gross_receipts,
        transcriptCount: totalTranscripts,
        complianceSummary,
      };
    });
}

/**
 * Auto-attach prior transcripts and compliance data to a new entity.
 *
 * Copies transcript URLs, compliance data (gross_receipts), and
 * marks the entity as completed (skipping 8821 + expert assignment).
 *
 * Returns true if transcripts were attached and 8821 was skipped.
 */
export async function attachPriorTranscripts(
  supabase: SupabaseClient,
  newEntityId: string,
  prior: PriorEntityInfo
): Promise<boolean> {
  const updatePayload: Record<string, any> = {};

  // Copy transcripts
  if (prior.transcriptUrls.length > 0) {
    updatePayload.transcript_urls = prior.transcriptUrls;
  }
  if (prior.transcriptHtmlUrls.length > 0) {
    updatePayload.transcript_html_urls = prior.transcriptHtmlUrls;
  }

  // Copy compliance data (preserve any existing entity_transcript_order)
  if (prior.grossReceipts) {
    const { data: currentEntity } = await supabase
      .from('request_entities')
      .select('gross_receipts')
      .eq('id', newEntityId)
      .single() as { data: { gross_receipts: Record<string, any> | null } | null; error: any };

    updatePayload.gross_receipts = {
      ...(currentEntity?.gross_receipts || {}),
      ...prior.grossReceipts,
    };
  }

  // Skip 8821 if signed within validity window
  let skip8821 = false;
  if (prior.signedEightyTwentyOneUrl && prior.signatureCreatedAt) {
    const signedDate = new Date(prior.signatureCreatedAt);
    const daysSinceSigned = (Date.now() - signedDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceSigned <= SIGNED_8821_VALID_DAYS) {
      updatePayload.signed_8821_url = prior.signedEightyTwentyOneUrl;
      updatePayload.signature_created_at = prior.signatureCreatedAt;
      updatePayload.status = 'completed';
      skip8821 = true;
    }
  }

  // If no valid 8821, still mark as completed (transcripts are already available)
  if (!skip8821 && prior.transcriptUrls.length > 0) {
    updatePayload.status = 'completed';
    skip8821 = true; // transcripts attached, no need for new 8821
  }

  const { error } = await supabase
    .from('request_entities')
    .update(updatePayload)
    .eq('id', newEntityId);

  if (error) {
    console.error(`[repeat-entity] Failed to attach transcripts to ${newEntityId}:`, error.message);
    return false;
  }

  return skip8821;
}

/**
 * Auto-enroll an entity in quarterly monitoring.
 *
 * Creates an entity_monitoring subscription with quarterly frequency.
 * Skips if entity already has active monitoring.
 *
 * Returns true if enrollment succeeded.
 */
export async function autoEnrollMonitoring(
  supabase: SupabaseClient,
  entityId: string,
  requestId: string,
  clientId: string,
  enrolledBy: string
): Promise<boolean> {
  // Check if already enrolled
  const { data: existing } = await supabase
    .from('entity_monitoring' as any)
    .select('id')
    .eq('entity_id', entityId)
    .in('status', ['active', 'paused'])
    .maybeSingle() as { data: any; error: any };

  if (existing) return false; // Already monitored

  // Compute next pull date (quarterly = 3 months from now)
  const nextPull = new Date();
  nextPull.setMonth(nextPull.getMonth() + 3);
  const nextPullDate = nextPull.toISOString().split('T')[0];

  const { error } = await supabase
    .from('entity_monitoring' as any)
    .insert({
      entity_id: entityId,
      request_id: requestId,
      client_id: clientId,
      enrolled_by: enrolledBy,
      frequency: 'quarterly',
      next_pull_date: nextPullDate,
      status: 'active',
      enrollment_fee: MONITORING_ENROLLMENT_FEE,
      per_pull_fee: MONITORING_PER_PULL_FEE,
      total_billed: MONITORING_ENROLLMENT_FEE,
      pull_history: [{
        date: new Date().toISOString(),
        status: 'auto_enrolled',
        type: 'repeat_entity_auto_enroll',
      }],
    }) as { error: any };

  if (error) {
    console.error(`[repeat-entity] Failed to enroll ${entityId} in monitoring:`, error.message);
    return false;
  }

  return true;
}
