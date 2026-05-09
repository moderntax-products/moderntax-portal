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
      id, request_id, completed_at, form_type,
      requests!inner(client_id, clients(monitoring_default_enabled))
    `)
    .eq('status', 'completed')
    .neq('form_type', 'W2_INCOME')
    .gte('completed_at', since.toISOString())
    .limit(2000) as { data: any[] | null };

  if (!entities || entities.length === 0) {
    return NextResponse.json({ enrolled: 0, skipped: 0, eligible: 0 });
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

  for (const ent of entities) {
    const clientId = ent.requests?.client_id;
    const optedOut = ent.requests?.clients?.monitoring_default_enabled === false;
    if (!clientId || optedOut || alreadyMonitored.has(ent.id)) { skipped++; continue; }
    try {
      const ok = await autoEnrollMonitoring(admin as any, ent.id, ent.request_id, clientId, 'cron');
      if (ok) enrolled++; else skipped++;
    } catch (err) {
      console.error(`[auto-enroll-monitoring] failed for ${ent.id}:`, err);
      skipped++;
    }
  }

  console.log(`[auto-enroll-monitoring] window=14d eligible=${entities.length} enrolled=${enrolled} skipped=${skipped}`);
  return NextResponse.json({ eligible: entities.length, enrolled, skipped });
}
