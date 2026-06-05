/**
 * Auto-Sync 8821 Cron Job
 * Polls Dropbox Sign for completed signature requests and syncs signed PDFs
 * to matching portal entities.
 * GET /api/cron/auto-sync-8821
 *
 * Called by Vercel Cron daily at 10:00 UTC (see vercel.json) with CRON_SECRET.
 * Idempotent: re-syncs an entity only when Dropbox reports a signed time we
 * haven't recorded yet, so it self-heals entities whose signed_8821_url is
 * still pointing at the unsigned pre-fill.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { downloadSignedPdf } from '@/lib/dropbox-sign';
import { sendStatusChangeNotification } from '@/lib/sendgrid';
import * as DropboxSign from '@dropbox/sign';
import { requireBearer } from '@/lib/auth-util';

const API_KEY = process.env.DROPBOX_SIGN_API_KEY || '';

function getApi(): DropboxSign.SignatureRequestApi {
  const api = new DropboxSign.SignatureRequestApi();
  api.username = API_KEY;
  return api;
}

export const maxDuration = 60;

// Cap downloads per run so a backlog of entities needing a (re)sync can't blow
// the 60s budget. The cron is idempotent and daily, so a backlog converges over
// a few runs; `remaining` in the response shows how many are still queued.
const MAX_SYNCS_PER_RUN = 20;

export async function GET(request: NextRequest) {
  try {
    // Validate CRON_SECRET
    const unauthorized = requireBearer(request, process.env.CRON_SECRET);
    if (unauthorized) return unauthorized;

    const supabase = createAdminClient();

    // Fetch signature requests from Dropbox Sign. We pass query='complete'
    // but their API has historically returned non-complete requests anyway,
    // and this cron used to download whatever PDF the API gave us — even
    // for awaiting_signature requests. Result: signed_8821_url got
    // populated with paths to unsigned template PDFs, AI calls then faxed
    // blank 8821s to IRS (Matt 2026-05-04: 3 Centerstone entities were
    // sitting in irs_queue with fake signed_8821_url values).
    //
    // Defense: always re-verify is_complete + every signature has
    // status_code='signed' BEFORE downloading and writing signed_8821_url.
    // The 'complete' filter remains as an optimization (smaller initial
    // page), but the per-row check below is the actual gate.
    const api = getApi();
    const allRequests: any[] = [];
    let page = 1;

    while (page <= 5) {
      const result = await api.signatureRequestList(undefined, page, 20, 'complete');
      const requests = result.body?.signatureRequests || [];
      if (requests.length === 0) break;
      allRequests.push(...requests);
      page++;
    }

    if (allRequests.length === 0) {
      return NextResponse.json({
        success: true,
        synced: 0,
        skipped: 0,
        failed: 0,
        message: 'No completed signature requests found on Dropbox Sign',
        processedAt: new Date().toISOString(),
      });
    }

    // Get all portal entities for matching
    const { data: entities } = await supabase
      .from('request_entities')
      .select('id, entity_name, signature_id, signed_8821_url, status, signature_created_at, request_id') as { data: any[] | null; error: any };

    const entityByName = new Map<string, any>();
    const entityBySigId = new Map<string, any>();
    (entities || []).forEach((e: any) => {
      entityByName.set(e.entity_name.toLowerCase().trim(), e);
      if (e.signature_id) entityBySigId.set(e.signature_id, e);
    });

    let synced = 0;
    let skipped = 0;
    let failed = 0;
    let remaining = 0;
    const errors: { signatureRequestId: string; error: string }[] = [];

    for (const dsReq of allRequests) {
      const signatureRequestId = dsReq.signatureRequestId;
      const title = dsReq.title || '';
      // Extract entity name from title: "8821 Consent Form Request - Entity Name"
      const entityName = title.replace(/^8821 Consent Form Request\s*-\s*/i, '').trim();

      // Try matching by signature_id first, then by entity name
      const portalEntity = entityBySigId.get(signatureRequestId) || entityByName.get(entityName.toLowerCase().trim());

      if (!portalEntity) {
        skipped++;
        continue;
      }

      try {
        // Hard gate: only download if Dropbox Sign confirms ALL signers
        // have actually signed. Without this check, downloadSignedPdf
        // happily returns the unsigned template PDF for awaiting_signature
        // requests — and we've been writing those into signed_8821_url.
        const isComplete = dsReq.isComplete === true;
        const sigList = (dsReq.signatures || []) as { statusCode?: string; signedAt?: number }[];
        const allSigned = sigList.length > 0 && sigList.every(s => s.statusCode === 'signed');
        if (!isComplete || !allSigned) {
          console.log(`[auto-sync-8821] Skip ${signatureRequestId} — is_complete=${isComplete}, signers=[${sigList.map(s => s.statusCode).join(',')}]`);
          skipped++;
          continue;
        }

        // Actual signed time (latest signer). Used both as the idempotency key
        // and the value written to signature_created_at (the old code wrote
        // dsReq.createdAt — the REQUEST-creation time — which is wrong).
        const signedTimes = sigList.map(s => s.signedAt).filter((t): t is number => !!t);
        const signedAtSec = signedTimes.length ? Math.max(...signedTimes) : (dsReq.createdAt || 0);
        const signedAtIso = new Date(signedAtSec * 1000).toISOString();

        // Idempotency — and the FIX for the Laxmi-class gap. The old code
        // skipped any entity that already had a signed_8821_url, but the
        // 8821-auto-send flow sets that field to the UNSIGNED pre-fill when
        // the form is sent for signature. So once a borrower signed, this
        // cron skipped forever and never replaced the prefill with the real
        // signed copy (18 completed entities found unsynced on 2026-06-04).
        // New rule: re-sync UNLESS we've already recorded THIS signed time.
        const existingSig = portalEntity.signature_created_at
          ? new Date(portalEntity.signature_created_at).getTime()
          : null;
        if (existingSig !== null && Math.abs(existingSig - signedAtSec * 1000) < 2000) {
          skipped++;
          continue;
        }

        // Per-run cap — this entity needs a sync but we've hit the budget;
        // defer it to the next daily run (idempotent, so it'll be picked up).
        if (synced >= MAX_SYNCS_PER_RUN) { remaining++; continue; }

        // Download signed PDF
        const pdfBuffer = await downloadSignedPdf(signatureRequestId);

        // Upload to Supabase storage
        const timestamp = Date.now();
        const storagePath = `8821/${portalEntity.id}/${timestamp}-signed-8821.pdf`;

        const { error: uploadError } = await supabase.storage
          .from('uploads')
          .upload(storagePath, pdfBuffer, {
            contentType: 'application/pdf',
            upsert: true,
          });

        if (uploadError) {
          console.error(`[auto-sync-8821] Upload failed for entity ${portalEntity.id}:`, uploadError);
          failed++;
          errors.push({ signatureRequestId, error: 'Upload to storage failed' });
          continue;
        }

        const oldStatus = portalEntity.status || 'pending';

        // Only ADVANCE status to 8821_signed from a pre-signature state. If the
        // entity is already further down the pipeline (assigned/in_progress/
        // irs_queue/completed/failed), leave status untouched — otherwise this
        // sync knocks a completed entity back to 8821_signed and re-queues it.
        const PRE_SIGNATURE = new Set(['pending', '8821_sent', 'awaiting_signature', '8821_pending', 'draft', 'created', 'new']);
        const advanceStatus = PRE_SIGNATURE.has(oldStatus);

        const update: Record<string, any> = {
          signed_8821_url: storagePath,
          signature_id: signatureRequestId,
          signature_created_at: signedAtIso,
        };
        if (advanceStatus) update.status = '8821_signed';

        // Update entity with signed PDF info
        const { error: updateError } = await supabase
          .from('request_entities')
          .update(update)
          .eq('id', portalEntity.id);

        if (updateError) {
          console.error(`[auto-sync-8821] Update failed for entity ${portalEntity.id}:`, updateError);
          failed++;
          errors.push({ signatureRequestId, error: 'Entity update failed' });
          continue;
        }

        // Notify processor ONLY when status actually advanced (a real "your
        // 8821 is signed" moment). Backfilling the signed copy onto an entity
        // that's already completed must NOT re-notify the processor.
        if (advanceStatus && portalEntity.request_id) {
          try {
            const { data: req } = await supabase
              .from('requests')
              .select('id, requested_by, loan_number')
              .eq('id', portalEntity.request_id)
              .single();

            if (req) {
              const { data: processor } = await supabase
                .from('profiles')
                .select('email')
                .eq('id', req.requested_by)
                .single();

              if (processor) {
                await sendStatusChangeNotification(
                  processor.email,
                  req.id,
                  req.loan_number,
                  oldStatus,
                  '8821_signed',
                  portalEntity.entity_name
                );
              }
            }
          } catch (notifErr) {
            console.error(`[auto-sync-8821] Notification error for entity ${portalEntity.id}:`, notifErr);
          }
        }

        synced++;
        console.log(`[auto-sync-8821] Synced: ${portalEntity.entity_name} (${signatureRequestId})`);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[auto-sync-8821] Failed for ${signatureRequestId}:`, errorMessage);
        failed++;
        errors.push({ signatureRequestId, error: errorMessage });
      }
    }

    return NextResponse.json({
      success: true,
      synced,
      skipped,
      failed,
      remaining,
      totalDropboxRequests: allRequests.length,
      processedAt: new Date().toISOString(),
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Auto-sync 8821 cron error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Cron job failed', details: errorMessage },
      { status: 500 }
    );
  }
}
