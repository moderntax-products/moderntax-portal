/**
 * Cron: monthly Platform Insights digest.
 *
 * An anonymized, network-wide snapshot to client-org processors & managers —
 * especially new sign-ups and never-ordered users (see lib/platform-insights.ts).
 *
 * SAFETY:
 *  - SHADOW BY DEFAULT behind PLATFORM_INSIGHTS_AUTOSEND=true. Until that env is
 *    set, this computes + logs "would send" and sends nothing.
 *  - Aggregate/anonymized numbers only — no client, loan, or taxpayer detail.
 *  - 25-day cooldown; dedupe fails CLOSED; honors nudges_paused / DO_NOT_SEND /
 *    reply-pause.
 *
 * Auth: Vercel cron Bearer secret. `?preview=true` renders a sample without
 * sending (works in shadow or live).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { logAuditEvent } from '@/lib/audit';
import {
  computePlatformInsights, findInsightsRecipients, alreadyReceived, sendInsights, buildInsightsText,
  INSIGHTS_ACTION, INSIGHTS_COOLDOWN_DAYS, MAX_SENDS_PER_RUN,
} from '@/lib/platform-insights';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const autoSend = process.env.PLATFORM_INSIGHTS_AUTOSEND === 'true';
  const preview = request.nextUrl.searchParams.get('preview') === 'true';
  const admin = createAdminClient();

  const result = {
    mode: autoSend ? 'live' : 'shadow',
    insights: null as any,
    eligible: 0,
    never_ordered: 0,
    sent: 0,
    skipped_cooldown: 0,
    skipped_filtered: 0,
    recipients: [] as string[],
    sample_never_ordered: null as string | null,
    sample_active: null as string | null,
    errors: [] as string[],
  };

  try {
    const insights = await computePlatformInsights(admin);
    result.insights = insights;

    const { recipients, skipped } = await findInsightsRecipients(admin);
    result.eligible = recipients.length;
    result.skipped_filtered = skipped;
    result.never_ordered = recipients.filter((r) => r.orderCount === 0).length;

    // Preview: render one of each segment without sending.
    if (preview) {
      const neverOrdered = recipients.find((r) => r.orderCount === 0);
      const active = recipients.find((r) => r.orderCount > 0);
      if (neverOrdered) result.sample_never_ordered = buildInsightsText(neverOrdered, insights);
      if (active) result.sample_active = buildInsightsText(active, insights);
    }

    const cooled = await alreadyReceived(admin, INSIGHTS_COOLDOWN_DAYS);
    let budget = MAX_SENDS_PER_RUN;

    for (const r of recipients) {
      if (budget <= 0) break;
      if (cooled.has(r.id)) { result.skipped_cooldown++; continue; }

      result.recipients.push(`${r.email}${r.orderCount === 0 ? ' (never ordered)' : ''}`);

      if (autoSend) {
        const ok = await sendInsights(r, insights);
        if (ok) {
          result.sent++;
          budget--;
          await logAuditEvent(admin, {
            action: INSIGHTS_ACTION,
            resourceType: 'profile',
            resourceId: r.id,
            userId: r.id,
            userEmail: r.email,
            details: {
              client: r.client_name,
              never_ordered: r.orderCount === 0,
              completed_all_time: insights.completedAllTime,
            },
          });
        } else {
          result.errors.push(`send failed: ${r.email}`);
        }
      }
    }
  } catch (e: any) {
    result.errors.push(e?.message || String(e));
  }

  return NextResponse.json(result);
}
