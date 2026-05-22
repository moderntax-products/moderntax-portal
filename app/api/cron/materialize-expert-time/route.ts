/**
 * GET /api/cron/materialize-expert-time
 *
 * Auto-derives expert_time_logs entries from observable signals so experts
 * don't have to remember to clock in/out. Runs nightly at 22:30 UTC, right
 * before admin-daily-summary at 23:00 UTC, so the summary picks up today's
 * derived hours.
 *
 * Sources materialized:
 *
 *   1. irs_call (Activity 2 — expert on phone with IRS agent)
 *      Every irs_call_sessions row for that expert in the window:
 *      start = scheduled_for (or initiated_at if present)
 *      end   = start + duration_seconds
 *      Skip rows with no duration (call never connected).
 *
 *   2. bookmarklet_session (Activity 3 — expert running v6.10 bookmarklet
 *      against IRS SOR inbox)
 *      Walks transcript_urls + transcript_html_urls on every entity assigned
 *      to that expert, parses the Date.now() prefix from each storage path,
 *      clusters timestamps within 5 minutes of each other into sessions.
 *      Padding: -2min before first upload, +2min after last upload.
 *
 *   Future (Layer 3): callback_tap from expert dashboard widget.
 *
 * Idempotency: relies on the partial unique index on (expert_id, source,
 * source_id). Migration `supabase/migration-expert-time-logs-source.sql`
 * must be applied first; cron returns a clear error otherwise.
 *
 * Auth: standard requireBearer(CRON_SECRET).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// How far back to materialize on each run. Default is "last 36 hours" so
// the nightly run picks up everything since the prior run plus some slack
// for late-arriving signals. Can be overridden via ?hours_back=N for backfills.
const DEFAULT_HOURS_BACK = 36;

// Bookmarklet session clustering threshold. Uploads more than this many
// minutes apart are treated as separate sessions.
const SESSION_GAP_MINUTES = 5;

// Padding either side of an upload cluster (warm-up + cool-down).
const SESSION_PADDING_MINUTES = 2;

interface MaterializeResult {
  source: 'irs_call' | 'bookmarklet_session';
  expert_id: string;
  source_id: string;
  start_at: string;
  end_at: string;
  hours_worked: number;
  notes: string;
}

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const url = request.nextUrl;
  const hoursBack = parseInt(url.searchParams.get('hours_back') || String(DEFAULT_HOURS_BACK), 10);
  const dryRun = url.searchParams.get('dry_run') === '1';

  const sb = createAdminClient();
  const windowStart = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  // ─── 1. Materialize IRS call sessions ──────────────────────────────────
  const irsCallEntries: MaterializeResult[] = [];
  try {
    const { data: calls } = await sb
      .from('irs_call_sessions')
      .select('id, expert_id, scheduled_for, initiated_at, duration_seconds, status, bland_call_id')
      .gte('created_at', windowStart);
    for (const c of (calls || []) as any[]) {
      if (!c.expert_id) continue;
      const dur = Number(c.duration_seconds || 0);
      if (dur < 30) continue; // skip calls under 30s (no real time on the line)
      const start = c.initiated_at || c.scheduled_for;
      if (!start) continue;
      const startDate = new Date(start);
      const endDate = new Date(startDate.getTime() + dur * 1000);
      const hours = Math.round((dur / 3600) * 100) / 100;
      irsCallEntries.push({
        source: 'irs_call',
        expert_id: c.expert_id,
        source_id: c.id,
        start_at: startDate.toISOString(),
        end_at: endDate.toISOString(),
        hours_worked: hours,
        notes: `IRS PPS call · ${c.status || 'completed'} · ${Math.round(dur / 60)} min on the line · bland_call_id=${c.bland_call_id?.slice(0, 12) || '-'}`,
      });
    }
  } catch (err) {
    console.error('[materialize-expert-time] IRS call materialization failed:', err);
  }

  // ─── 2. Materialize bookmarklet sessions ───────────────────────────────
  // For each expert with assignments, gather all upload timestamps from
  // their entities' transcript paths, cluster, and produce session entries.
  const bookmarkletEntries: MaterializeResult[] = [];
  try {
    const { data: assignments } = await sb
      .from('expert_assignments')
      .select(`
        expert_id,
        request_entities!inner(id, entity_name, transcript_urls, transcript_html_urls)
      `)
      .not('expert_id', 'is', null);

    // Group entities per expert
    const expertUploads: Record<string, { entityId: string; entityName: string; ts: number }[]> = {};
    for (const a of (assignments || []) as any[]) {
      const expertId = a.expert_id;
      const e = a.request_entities;
      if (!e) continue;
      const allUrls: string[] = [...(e.transcript_urls || []), ...(e.transcript_html_urls || [])];
      for (const url of allUrls) {
        const filename = url.split('/').pop() || '';
        const tsMatch = filename.match(/^(\d{13})-/); // 13-digit ms epoch from Date.now()
        if (!tsMatch) continue;
        const ts = parseInt(tsMatch[1], 10);
        if (!Number.isFinite(ts)) continue;
        if (ts < Date.parse(windowStart)) continue; // outside window
        if (!expertUploads[expertId]) expertUploads[expertId] = [];
        expertUploads[expertId].push({ entityId: e.id, entityName: e.entity_name, ts });
      }
    }

    // For each expert, sort timestamps + cluster
    for (const [expertId, uploads] of Object.entries(expertUploads)) {
      const sorted = uploads.sort((a, b) => a.ts - b.ts);
      const clusters: { start: number; end: number; entities: Set<string>; uploadCount: number }[] = [];
      let current: typeof clusters[number] | null = null;
      const gapMs = SESSION_GAP_MINUTES * 60 * 1000;

      for (const u of sorted) {
        if (!current || u.ts - current.end > gapMs) {
          // Start a new cluster
          current = { start: u.ts, end: u.ts, entities: new Set([u.entityName]), uploadCount: 1 };
          clusters.push(current);
        } else {
          current.end = u.ts;
          current.entities.add(u.entityName);
          current.uploadCount++;
        }
      }

      for (const cluster of clusters) {
        const pad = SESSION_PADDING_MINUTES * 60 * 1000;
        const startDate = new Date(cluster.start - pad);
        const endDate = new Date(cluster.end + pad);
        const hours = Math.round(((endDate.getTime() - startDate.getTime()) / 3600000) * 100) / 100;
        const sourceId = `${expertId}|${cluster.start}`;
        const entityList = Array.from(cluster.entities).slice(0, 3).join(', ') + (cluster.entities.size > 3 ? `… +${cluster.entities.size - 3} more` : '');
        bookmarkletEntries.push({
          source: 'bookmarklet_session',
          expert_id: expertId,
          source_id: sourceId,
          start_at: startDate.toISOString(),
          end_at: endDate.toISOString(),
          hours_worked: hours,
          notes: `Bookmarklet session · ${cluster.uploadCount} transcripts across ${cluster.entities.size} entit${cluster.entities.size === 1 ? 'y' : 'ies'} (${entityList})`,
        });
      }
    }
  } catch (err) {
    console.error('[materialize-expert-time] Bookmarklet session materialization failed:', err);
  }

  // ─── 3. Insert with conflict-do-nothing ────────────────────────────────
  const allEntries = [...irsCallEntries, ...bookmarkletEntries];
  let inserted = 0;
  let skipped = 0;
  const errors: { source_id: string; error: string }[] = [];

  if (!dryRun && allEntries.length > 0) {
    for (const entry of allEntries) {
      // Try INSERT; if the unique index hits (entry already materialized), skip.
      const { error } = await sb.from('expert_time_logs').insert({
        expert_id: entry.expert_id,
        start_at: entry.start_at,
        end_at: entry.end_at,
        break_minutes: 0,
        hours_worked: entry.hours_worked,
        tins_completed: 0,
        notes: entry.notes,
        source: entry.source,
        source_id: entry.source_id,
      } as any);
      if (error) {
        // Conflict on partial unique index = already materialized = success-ish
        if (/duplicate key|unique constraint/i.test(error.message)) {
          skipped++;
        } else if (/column .* source/i.test(error.message)) {
          // Migration not applied yet
          return NextResponse.json({
            error: 'Migration not applied yet',
            detail: 'expert_time_logs.source column does not exist. Apply supabase/migration-expert-time-logs-source.sql first via the Supabase SQL editor.',
            error_sample: error.message,
          }, { status: 500 });
        } else {
          errors.push({ source_id: entry.source_id, error: error.message });
        }
      } else {
        inserted++;
      }
    }
  }

  return NextResponse.json({
    success: true,
    dry_run: dryRun,
    window_start: windowStart,
    hours_back: hoursBack,
    candidates: {
      irs_call: irsCallEntries.length,
      bookmarklet_session: bookmarkletEntries.length,
      total: allEntries.length,
    },
    inserted,
    skipped_duplicate: skipped,
    errors,
    // In dry-run mode, return the entries so you can eyeball them
    preview: dryRun ? allEntries.slice(0, 20) : undefined,
  });
}
