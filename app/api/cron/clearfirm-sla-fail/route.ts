/**
 * GET /api/cron/clearfirm-sla-fail
 *
 * Daily SLA enforcement for Clearfirm API requests.
 *
 * Per the Clearfirm contract: every API request must complete within 24 hours
 * or be confirmed failed via the webhook. Without this cron, stuck requests
 * silently sit in irs_queue / 8821_sent for weeks (the May 8 cleanup found 11
 * stale requests, the oldest 35 days old). This cron sweeps daily and
 * auto-fails anything past the SLA so Clearfirm gets a clean signal and can
 * re-submit.
 *
 * Behavior:
 *   - Filter: client_id = Clearfirm AND intake_method='api' AND
 *             status NOT IN (completed, cancelled, failed) AND
 *             created_at < now - SLA_HOURS.
 *   - For each match: set request.status='failed' + entity statuses to
 *     'failed' + fire the error webhook to Clearfirm.
 *   - Idempotent — already-failed requests aren't re-touched.
 *
 * Schedule: daily at 13:00 UTC (= 6 AM PT / 9 AM ET) — early in the business
 * day so admins see the closures in their morning summary email.
 *
 * SLA window:
 *   SLA_HOURS=24 by default. Override via env CLEARFIRM_SLA_HOURS for
 *   adjustment without code change (e.g., 36h for soft cutoff during
 *   migration windows).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { triggerErrorWebhookForRequest } from '@/lib/webhook';
import { requireBearer } from '@/lib/auth-util';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Hard-coded Clearfirm client_id — only this client uses the API SLA path.
// If we add other API integrations in the future, this becomes a list/lookup.
const CLEARFIRM_CLIENT_ID = '09d29d80-eccc-4865-9e9b-97e1cd396464';

export async function GET(req: NextRequest) {
  const unauthorized = requireBearer(req, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const slaHours = Number(process.env.CLEARFIRM_SLA_HOURS) || 24;
  const cutoff = new Date(Date.now() - slaHours * 60 * 60 * 1000);
  const admin = createAdminClient();

  const { data: stale } = await admin
    .from('requests')
    .select('id, loan_number, status, external_request_token, created_at, request_entities(id, entity_name, status)')
    .eq('client_id', CLEARFIRM_CLIENT_ID)
    .eq('intake_method', 'api')
    .not('status', 'in', '(completed,cancelled,failed)')
    .lt('created_at', cutoff.toISOString())
    .limit(100) as { data: any[] | null };

  if (!stale || stale.length === 0) {
    return NextResponse.json({ failed: 0, scanned: 0, sla_hours: slaHours });
  }

  const closureNote = `[Auto-failed by SLA cron ${new Date().toISOString()}] Clearfirm API contract requires completion within ${slaHours}h. Marking failed + notifying webhook so Clearfirm can re-submit.`;

  let failed = 0;
  let webhookOK = 0;
  let webhookFail = 0;
  const details: any[] = [];

  for (const r of stale) {
    try {
      // 1. Set request → failed (append closure note)
      const { data: existing } = await admin
        .from('requests').select('notes').eq('id', r.id).single() as any;
      const newNotes = existing?.notes ? `${existing.notes}\n\n${closureNote}` : closureNote;
      const { error: rErr } = await (admin.from('requests') as any)
        .update({ status: 'failed', completed_at: new Date().toISOString(), notes: newNotes })
        .eq('id', r.id);
      if (rErr) {
        console.error(`[clearfirm-sla-fail] request update failed for ${r.id}:`, rErr.message);
        details.push({ loan: r.loan_number, error: rErr.message });
        continue;
      }

      // 2. Set non-terminal entities → failed
      for (const e of (r.request_entities || [])) {
        if (['failed', 'completed', 'cancelled'].includes(e.status)) continue;
        await (admin.from('request_entities') as any)
          .update({ status: 'failed', completed_at: new Date().toISOString() })
          .eq('id', e.id);
      }

      // 3. Fire webhook to Clearfirm
      const deliveryId = await triggerErrorWebhookForRequest(
        admin as any,
        r.id,
        `Stale request auto-failed after ${slaHours}h SLA breach. Re-submit if still needed.`,
      );
      if (deliveryId) webhookOK++;

      failed++;
      const ageH = Math.floor((Date.now() - new Date(r.created_at).getTime()) / 3600000);
      details.push({
        loan: r.loan_number,
        request_id: r.id,
        age_hours: ageH,
        prior_status: r.status,
        entities: (r.request_entities || []).length,
        webhook_delivery_id: deliveryId,
      });
    } catch (err: any) {
      console.error(`[clearfirm-sla-fail] error for ${r.id}:`, err);
      webhookFail++;
      details.push({ loan: r.loan_number, error: err?.message });
    }
  }

  console.log(`[clearfirm-sla-fail] scanned=${stale.length} failed=${failed} webhooksOK=${webhookOK} webhooksFail=${webhookFail} sla=${slaHours}h`);

  return NextResponse.json({
    sla_hours: slaHours,
    cutoff: cutoff.toISOString(),
    scanned: stale.length,
    failed,
    webhooks_delivered: webhookOK,
    webhooks_failed: webhookFail,
    details,
  });
}
