/**
 * Cron: reclaim stalled ACCEPTED batches.
 *
 * Sweeps assignment_batches in status='accepted' whose completion_deadline
 * (accepted_at + 24h) has passed — an expert accepted work and then went
 * quiet. Marks the batch 'expired', releases its still-open per-entity
 * assignments, and reverts those entities to '8821_signed' so the
 * auto-assign-experts cron re-offers them to the next verifier. Completed
 * work in a partially-finished batch is preserved.
 *
 * Without this, one non-responsive expert silently locked up to 8 entities
 * AND removed themselves from the assignment pool indefinitely (the biggest
 * silent capacity leak). Sibling of expire-batches, which only handles the
 * pending-acceptance window.
 *
 * Runs every 15 minutes per vercel.json.
 * Auth: Vercel cron Bearer secret.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { expireStalledAcceptedBatches } from '@/lib/assignment-batch';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  // Vercel cron auth — Authorization: Bearer ${CRON_SECRET}
  const cronSecret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  try {
    const result = await expireStalledAcceptedBatches(admin);
    if (result.reclaimed > 0) {
      console.log(`[cron/expire-accepted-batches] reclaimed ${result.reclaimed} stalled batch(es), released ${result.entitiesReleased} entit(ies) back to the pool`);
    }
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error('[cron/expire-accepted-batches] failed:', err);
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 });
  }
}
