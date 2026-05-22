/**
 * GET /api/cron/auto-enroll-monitoring
 *
 * Daily safety-net cron. The per-completion hook in expert/upload-transcript
 * handles the happy path (enroll on flip to status='completed'), but it can
 * miss entities when:
 *   - The transcript was uploaded by a path other than expert/upload-transcript
 *     (manual admin path, ClearFirm bot, pre-portal backfill, historical import)
 *   - The hook errored (autoEnrollMonitoring is best-effort and logs but doesn't fail)
 *   - A new client gets `monitoring_default_enabled` flipped from false → true
 *     and we want their existing completed entities to back-enroll.
 *
 * This cron sweeps daily and enrolls anything that should be monitored but
 * isn't. Idempotent (autoEnrollMonitoring short-circuits on existing).
 *
 * NO-RECORD-FOUND OVERRIDE (added 2026-05-22, driver: Justin Kim @ Centerstone):
 * Even when a client has `monitoring_default_enabled = false`, we still
 * auto-enroll any entity whose most-recent requested year came back as a
 * "no record of return filed" stub AND whose filing deadline has passed.
 * The lender genuinely needs to know when the borrower files the missing
 * year — this is materially different from generic post-funding monitoring,
 * so the opt-out flag doesn't apply. Billing uses the client's contracted
 * `billing_rate_monitoring` rate (Centerstone: $25/mo).
 *
 * Schedule: daily at 09:30 UTC (after the morning monitoring-repull cron at
 * 07:00 UTC, so any newly-pulled transcripts that just flipped to completed
 * get picked up the same day).
 *
 * Auth: CRON_SECRET only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { autoEnrollMonitoring } from '@/lib/repeat-entity';
import { requireBearer } from '@/lib/auth-util';
import { shouldAutoEnrollForNoRecord } from '@/lib/no-record-monitoring';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const unauthorized = requireBearer(req, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();

  // Look at the last 14 days of completions (catches anything the hook
  // missed without scanning the entire historical table every day — the
  // initial backfill endpoint handles older entities).
  const since = new Date();
  since.setDate(since.getDate() - 14);

  const { data: entities } = await admin
    .from('request_entities')
    .select(`
      id, request_id, completed_at, form_type, years,
      transcript_urls, transcript_html_urls,
      requests!inner(client_id, clients(monitoring_default_enabled, billing_rate_monitoring))
    `)
    .eq('status', 'completed')
    .neq('form_type', 'W2_INCOME')
    .gte('completed_at', since.toISOString())
    .limit(2000) as { data: any[] | null };

  if (!entities || entities.length === 0) {
    return NextResponse.json({ enrolled: 0, skipped: 0, eligible: 0, no_record_overrides: 0 });
  }

  const ids = entities.map((e: any) => e.id);
  const { data: monitored } = await admin
    .from('entity_monitoring')
    .select('entity_id')
    .in('entity_id', ids)
    .in('status', ['active', 'paused']) as { data: any[] | null };
  const alreadyMonitored = new Set((monitored || []).map((m: any) => m.entity_id));

  let enrolled = 0;
  let skipped = 0;
  let noRecordOverrides = 0;
  const overrideDetails: Array<{ entity_id: string; reason: string }> = [];

  for (const ent of entities) {
    const clientId = ent.requests?.client_id;
    const optedOut = ent.requests?.clients?.monitoring_default_enabled === false;
    if (!clientId || alreadyMonitored.has(ent.id)) { skipped++; continue; }

    // No-record-found override: even if client opted out, enroll when the
    // most-recent year is a no-record stub with deadline passed.
    let noRecordOverride = false;
    let noRecordReason = '';
    if (optedOut) {
      const decision = shouldAutoEnrollForNoRecord({
        form_type: ent.form_type,
        years: ent.years,
        transcript_urls: ent.transcript_urls,
        transcript_html_urls: ent.transcript_html_urls,
      });
      if (decision.shouldEnroll) {
        noRecordOverride = true;
        noRecordReason = decision.reason;
      } else {
        skipped++;
        continue;
      }
    }

    try {
      const perPullFee = ent.requests?.clients?.billing_rate_monitoring ?? undefined;
      const ok = await autoEnrollMonitoring(
        admin as any,
        ent.id,
        ent.request_id,
        clientId,
        'cron',
        noRecordOverride
          ? {
              // Monthly polling — the lender wants to see this flip as soon
              // as IRS shows the filed return on the wire.
              frequency: 'monthly',
              enrollmentFee: 0,
              perPullFee,
              enrollmentType: 'no_record_found_auto_enroll',
            }
          : {},
      );
      if (ok) {
        enrolled++;
        if (noRecordOverride) {
          noRecordOverrides++;
          overrideDetails.push({ entity_id: ent.id, reason: noRecordReason });
        }
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`[auto-enroll-monitoring] failed for ${ent.id}:`, err);
      skipped++;
    }
  }

  console.log(
    `[auto-enroll-monitoring] window=14d eligible=${entities.length} enrolled=${enrolled} ` +
    `skipped=${skipped} no_record_overrides=${noRecordOverrides}`,
  );
  return NextResponse.json({
    eligible: entities.length,
    enrolled,
    skipped,
    no_record_overrides: noRecordOverrides,
    override_details: overrideDetails,
  });
}
