/**
 * Cron: weekly feature digest — what changed in ordering.
 *
 * Thursdays 9am PT. Sends each active processor only the changelog entries
 * they haven't already been told about (see lib/feature-digest.ts), so this
 * keeps working week after week without anyone rewriting copy, and nobody
 * hears about the same feature twice.
 *
 * SAFETY:
 *  - SHADOW BY DEFAULT behind FEATURE_DIGEST_AUTOSEND=true.
 *  - Never emails anyone who cannot currently place an order — blocked users
 *    come back in `blocked` as a bug queue instead. Announcing a feature to
 *    someone who hits a 400/402 using it is worse than saying nothing.
 *  - Only processors with at least one order; never-activated users belong to
 *    the first-order activation track.
 *  - 6-day cooldown, dedupe fails CLOSED (a silently-empty dedupe set is how
 *    order-growth nearly re-sent to its whole book — fixed 2026-07-22).
 *  - Respects nudges_paused + the explicit DO_NOT_SEND list.
 *
 * Auth: Vercel cron Bearer secret. `?force=true` previews off-schedule.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { logAuditEvent } from '@/lib/audit';
import {
  findDigestTargets, alreadyDigested, sendFeatureDigest, buildDigestText,
  DIGEST_ACTION, DIGEST_COOLDOWN_DAYS, MAX_SENDS_PER_RUN,
} from '@/lib/feature-digest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const autoSend = process.env.FEATURE_DIGEST_AUTOSEND === 'true';
  const preview = request.nextUrl.searchParams.get('preview') === 'true';
  const admin = createAdminClient();

  const result = {
    mode: autoSend ? 'live' : 'shadow',
    eligible: 0,
    sent: 0,
    skipped_cooldown: 0,
    skipped_filtered: 0,
    recipients: [] as string[],
    blocked: [] as Array<{ email: string; client: string | null; reason: string }>,
    sample: null as string | null,
    errors: [] as string[],
  };

  try {
    const { targets, blocked, skipped } = await findDigestTargets(admin);
    result.eligible = targets.length;
    result.skipped_filtered = skipped;
    result.blocked = blocked.map((b) => ({ email: b.email, client: b.client_name, reason: b.reason }));

    if (blocked.length > 0) {
      console.warn(
        `[feature-digest] ${blocked.length} active user(s) CANNOT order — not emailed:`,
        blocked.map((b) => `${b.email} (${b.reason})`).join('; '),
      );
    }

    const cooled = await alreadyDigested(admin, DIGEST_COOLDOWN_DAYS);
    let budget = MAX_SENDS_PER_RUN;

    for (const t of targets) {
      if (budget <= 0) break;
      if (cooled.has(t.id)) { result.skipped_cooldown++; continue; }

      result.recipients.push(`${t.email} (${t.entries.length} update${t.entries.length === 1 ? '' : 's'})`);
      if (preview && !result.sample) result.sample = buildDigestText(t);

      if (autoSend) {
        const ok = await sendFeatureDigest(t);
        if (ok) {
          result.sent++;
          budget--;
          await logAuditEvent(admin, {
            action: DIGEST_ACTION,
            resourceType: 'profile',
            resourceId: t.id,
            userId: t.id,
            userEmail: t.email,
            details: {
              client: t.client_name,
              entry_count: t.entries.length,
              entries: t.entries.map((e) => e.title),
              first_time: t.firstTime,
            },
          });
        } else {
          result.errors.push(`send failed: ${t.email}`);
        }
      }
    }
  } catch (e: any) {
    result.errors.push(e?.message || String(e));
  }

  return NextResponse.json(result);
}
