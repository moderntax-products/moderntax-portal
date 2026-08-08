/**
 * Cron: storage lifecycle cleanup for the `uploads` bucket.
 *
 * Prunes THROWAWAY files that accumulate with no lifecycle — the root cause of
 * the 2026-07-17 Supabase quota trip. Only two prefixes are ever touched, and
 * only files older than their age gate:
 *
 *   8821/adhoc/{userId}/…        — pre-save "Download 8821" copies (single-use;   7-day gate)
 *   {clientId}/unmatched-8821/…  — inbound signed-8821s we couldn't match (triage; 30-day gate)
 *
 * NEITHER prefix is ever referenced by request_entities (adhoc has no entityId;
 * unmatched holds were never attached), so pruning them cannot orphan a
 * compliance document. Signed / regenerated / admin-uploaded 8821s and
 * transcripts live under other prefixes and are NEVER touched here.
 *
 * ?dry_run=1 reports what WOULD be deleted without deleting. Scheduled weekly.
 * Auth: Vercel cron Bearer secret.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { collectFiles, fmtBytes, UPLOADS_BUCKET } from '@/lib/storage-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DAY = 24 * 60 * 60 * 1000;
const ADHOC_AGE_MS = 7 * DAY;
const UNMATCHED_AGE_MS = 30 * DAY;

/** Looks like a UUID (a client_id folder at the bucket root). */
const isUuid = (s: string) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const dryRun = request.nextUrl.searchParams.get('dry_run') === '1';
  const admin = createAdminClient();
  const now = Date.now();

  const toDelete: { path: string; size: number; age_days: number; reason: string }[] = [];
  const warnings: string[] = [];

  const gather = async (prefix: string, ageMs: number, reason: string) => {
    try {
      const { files, capped } = await collectFiles(admin, prefix, 10000);
      if (capped) warnings.push(`${prefix}: scan capped at 10k files`);
      for (const f of files) {
        const ageMsFile = f.created_at ? now - Date.parse(f.created_at) : Infinity;
        if (ageMsFile >= ageMs) {
          toDelete.push({ path: f.path, size: f.size, age_days: Math.round(ageMsFile / DAY), reason });
        }
      }
    } catch (e: any) {
      warnings.push(`${prefix}: ${e?.message || 'list failed'}`);
    }
  };

  // 1. Pre-save adhoc 8821 downloads.
  await gather('8821/adhoc', ADHOC_AGE_MS, 'adhoc_8821_download');

  // 2. Unmatched inbound-8821 holds, under each client folder.
  try {
    const { data: roots } = await admin.storage.from(UPLOADS_BUCKET).list('', { limit: 1000 });
    for (const r of roots || []) {
      if (!r.id && r.name && isUuid(r.name)) {
        await gather(`${r.name}/unmatched-8821`, UNMATCHED_AGE_MS, 'unmatched_8821_hold');
      }
    }
  } catch (e: any) {
    warnings.push(`root list: ${e?.message || 'failed'}`);
  }

  const freedBytes = toDelete.reduce((s, f) => s + f.size, 0);

  let deleted = 0;
  if (!dryRun && toDelete.length) {
    // Supabase remove() takes up to ~1000 paths per call; batch to be safe.
    const paths = toDelete.map((f) => f.path);
    for (let i = 0; i < paths.length; i += 500) {
      const batch = paths.slice(i, i + 500);
      const { error } = await admin.storage.from(UPLOADS_BUCKET).remove(batch);
      if (error) warnings.push(`remove batch @${i}: ${error.message}`);
      else deleted += batch.length;
    }
  }

  const result = {
    success: true,
    dry_run: dryRun,
    candidates: toDelete.length,
    deleted: dryRun ? 0 : deleted,
    freed: fmtBytes(freedBytes),
    freed_bytes: freedBytes,
    by_reason: {
      adhoc_8821_download: toDelete.filter((f) => f.reason === 'adhoc_8821_download').length,
      unmatched_8821_hold: toDelete.filter((f) => f.reason === 'unmatched_8821_hold').length,
    },
    warnings,
  };
  console.log(`[storage-cleanup] ${dryRun ? 'DRY RUN' : 'DELETED'} ${result.deleted}/${toDelete.length} files, ${result.freed} freed`);
  return NextResponse.json(result);
}
