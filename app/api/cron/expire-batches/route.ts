/**
 * Cron: expire stale batch offers.
 *
 * Sweeps assignment_batches in status='pending_acceptance' whose
 * acceptance_deadline (offered_at + 30 min) has passed. Marks them
 * expired and returns the per-entity assignments to the pool.
 *
 * Runs every 5 minutes per vercel.json.
 * Auth: Vercel cron Bearer secret.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { expireOverdueBatches } from '@/lib/assignment-batch';

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
    const result = await expireOverdueBatches(admin);
    return NextResponse.json({ success: true, expired: result.expired });
  } catch (err) {
    console.error('[cron/expire-batches] failed:', err);
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 });
  }
}
