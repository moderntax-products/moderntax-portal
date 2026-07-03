/**
 * Cron: auto-fulfill-from-record sweep
 * GET /api/cron/auto-fulfill-from-record
 *
 * Self-healing counterpart to the intake-time check. Scans open requests still
 * waiting in the queue and fulfills any whose entities now match transcripts
 * already on file (matched by TIN) — covering requests that were queued before
 * the source pull finished, created before this feature shipped, or where two
 * clients ordered the same entity. Reuses the exact intake logic via
 * autoFulfillRequestFromRecord (attach + deliver for API, attach + complete for
 * portal intake).
 *
 * Auth: Vercel cron Bearer secret (CRON_SECRET).
 * Expected cadence: every 15 minutes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { autoFulfillRequestFromRecord } from '@/lib/auto-fulfill';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Bound the work per run. Open entities scanned, then deduped to requests.
const ENTITY_SCAN_LIMIT = 500;
const MAX_REQUESTS_PER_RUN = 100;

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  try {
    const supabase = createAdminClient();

    // Candidate entities: still open (queued / signed) and not yet fulfilled
    // (no transcripts). Oldest first so the longest-waiting requests win.
    const { data: openEntities } = await supabase
      .from('request_entities')
      .select('request_id, transcript_urls, transcript_html_urls, created_at')
      .in('status', ['irs_queue', '8821_signed'])
      .order('created_at', { ascending: true })
      .limit(ENTITY_SCAN_LIMIT) as { data: any[] | null };

    const requestIds: string[] = [];
    const seen = new Set<string>();
    for (const e of openEntities || []) {
      const unfulfilled = ((e.transcript_urls || []).length + (e.transcript_html_urls || []).length) === 0;
      if (!unfulfilled) continue;
      if (seen.has(e.request_id)) continue;
      seen.add(e.request_id);
      requestIds.push(e.request_id);
      if (requestIds.length >= MAX_REQUESTS_PER_RUN) break;
    }

    let servedRequests = 0;
    let servedEntities = 0;
    let completedRequests = 0;
    const details: Array<{ request_id: string; served: number; completed: boolean }> = [];

    for (const rid of requestIds) {
      try {
        const r = await autoFulfillRequestFromRecord(supabase, rid);
        if (r.served.length > 0) {
          servedRequests++;
          servedEntities += r.served.length;
          if (r.requestCompleted) completedRequests++;
          details.push({ request_id: rid, served: r.served.length, completed: r.requestCompleted });
        }
      } catch (err) {
        console.error(`[auto-fulfill-cron] request ${rid} failed:`, err);
      }
    }

    const scannedCapped = (openEntities?.length || 0) >= ENTITY_SCAN_LIMIT || requestIds.length >= MAX_REQUESTS_PER_RUN;
    if (scannedCapped) {
      console.log(`[auto-fulfill-cron] Hit scan cap — ${requestIds.length} requests checked this run; remainder retried next run.`);
    }

    return NextResponse.json({
      ok: true,
      scanned_requests: requestIds.length,
      served_requests: servedRequests,
      served_entities: servedEntities,
      completed_requests: completedRequests,
      capped: scannedCapped,
      details,
    });
  } catch (err) {
    console.error('[auto-fulfill-cron] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'auto-fulfill sweep failed' },
      { status: 500 },
    );
  }
}
