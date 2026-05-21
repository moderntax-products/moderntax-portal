/**
 * Admin Daily Summary Cron Job
 *
 * Sends daily operations summary to all admins covering ModernTax's full
 * cross-timezone business day:
 *
 *   START: 4 AM Pacific (= 7 AM Eastern) — earliest expert/processor active
 *   END:   7 PM Eastern (= 4 PM Pacific) — last east-coast workday minute
 *
 * That's the "daily activity window" Matt cares about. Anything fired during
 * this 12-hour span counts toward today's summary; activity outside that
 * window (overnight UTC, weekends, etc.) doesn't pollute the numbers.
 *
 * Cron schedule: 23:00 UTC daily (vercel.json) — that's 7 PM ET in EDT,
 * 6 PM ET in EST. Fires right at-or-just-before the east-coast cutoff so
 * the email lands in admin inboxes at end of business.
 *
 * GET /api/cron/admin-daily-summary
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendAdminDailySummary } from '@/lib/sendgrid';
import type { AdminDailySummaryStats } from '@/lib/types';
import { businessDayStart, pacificDateLabel } from '@/lib/business-day';
import { computeDailyCogs, grossMargin } from '@/lib/daily-cogs';
import { requireBearer } from '@/lib/auth-util';

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    // Validate CRON_SECRET
    const unauthorized = requireBearer(request, process.env.CRON_SECRET);
    if (unauthorized) return unauthorized;

    const supabase = createAdminClient();

    // Get all admin users
    const { data: admins, error: adminsError } = await supabase
      .from('profiles')
      .select('id, email, full_name')
      .eq('role', 'admin')
      .not('email', 'is', null) as { data: { id: string; email: string; full_name: string | null }[] | null; error: any };

    if (adminsError || !admins || admins.length === 0) {
      console.error('No admins found or error:', adminsError);
      return NextResponse.json(
        { error: 'No admins found' },
        { status: 500 }
      );
    }

    // Business-day window: 4 AM PT through current time (cron fires at 7 PM
    // ET). All "today's …" stats use this anchor — see lib/business-day.ts
    // for the full rationale and helpers.
    const now = new Date();
    const todayStart = businessDayStart(now);
    const todayISO = todayStart.toISOString();
    const dateLabel = pacificDateLabel(now);

    // Pre-compute the set of request IDs that belong to sandbox clients
    // (slug ending in `-sandbox`). Every entity/request count below uses
    // `.not('request_id', 'in', sandboxRequestIdsSql)` so the daily email
    // doesn't surface counts that include synthetic prospect demo data.
    // Without this, today's email would include the 6 Moxie sandbox
    // entity completions + the cumulative 14 sandbox entities sitting in
    // various states.
    const { data: sandboxClients } = await supabase
      .from('clients').select('id').ilike('slug', '%-sandbox') as { data: { id: string }[] | null };
    const sandboxClientIds = (sandboxClients || []).map(c => c.id);
    const { data: sandboxRequests } = sandboxClientIds.length
      ? await supabase.from('requests').select('id').in('client_id', sandboxClientIds) as { data: { id: string }[] | null }
      : { data: [] };
    const sandboxRequestIds = (sandboxRequests || []).map(r => r.id);
    // Postgrest .not('in', ...) takes the values as a parenthesized SQL list string.
    const sandboxIdList = sandboxRequestIds.length
      ? `(${sandboxRequestIds.map(id => `"${id}"`).join(',')})`
      : `("__none__")`;

    // New entities today (from requests created today)
    const { data: newRequestsData } = await supabase
      .from('requests')
      .select('request_entities(id)')
      .gte('created_at', todayISO)
      .not('client_id', 'in', sandboxClientIds.length ? `(${sandboxClientIds.map(id => `"${id}"`).join(',')})` : `("__none__")`) as { data: any[] | null; error: any };
    const newRequestsToday = (newRequestsData || []).reduce(
      (sum: number, r: any) => sum + (r.request_entities?.length || 0), 0
    );

    // Entities completed today (excluding sandbox requests)
    const { count: completionsToday } = await supabase
      .from('request_entities')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'completed')
      .gte('completed_at', todayISO)
      .not('request_id', 'in', sandboxIdList);

    // Entities failed today (excluding sandbox requests)
    const { count: failuresToday } = await supabase
      .from('request_entities')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'failed')
      .gte('updated_at', todayISO)
      .not('request_id', 'in', sandboxIdList);

    // Active entities (not completed or failed) — excluding sandbox requests
    const { count: activeRequests } = await supabase
      .from('request_entities')
      .select('*', { count: 'exact', head: true })
      .not('status', 'in', '("completed","failed")')
      .not('request_id', 'in', sandboxIdList);

    // Expert completions today
    const { count: expertCompletionsToday } = await supabase
      .from('expert_assignments')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'completed')
      .gte('completed_at', todayISO);

    // Expert SLA compliance (from all completed assignments today)
    const { data: slaData } = await supabase
      .from('expert_assignments')
      .select('sla_met')
      .eq('status', 'completed')
      .gte('completed_at', todayISO) as { data: { sla_met: boolean | null }[] | null; error: any };

    let slaCompliance = 100;
    if (slaData && slaData.length > 0) {
      const slaMet = slaData.filter((s) => s.sla_met === true).length;
      slaCompliance = Math.round((slaMet / slaData.length) * 100);
    }

    // Entities completed today (excluding sandbox requests)
    const { count: entitiesCompletedToday } = await supabase
      .from('request_entities')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'completed')
      .gte('completed_at', todayISO)
      .not('request_id', 'in', sandboxIdList);

    // Entities pending (excluding sandbox requests)
    const { count: entitiesPending } = await supabase
      .from('request_entities')
      .select('*', { count: 'exact', head: true })
      .not('status', 'in', '("completed","failed")')
      .not('request_id', 'in', sandboxIdList);

    // -----------------------------------------------------------------
    // Real-time revenue
    // -----------------------------------------------------------------
    //  • per_tin clients: completions today × (billing_rate_csv | billing_rate_pdf)
    //                     minus any of their first-3 all-time entities (free trial)
    //  • subscription clients: today contributes ONLY the overage portion
    //                     $20/entity for entities this calendar month beyond
    //                     subscription_included_entities. The flat monthly
    //                     fee is booked on the 1st by auto-invoice, not daily.
    //
    // Kept in sync with /api/cron/auto-invoice so the daily email reconciles
    // to whatever Mercury invoices at month-end.
    // -----------------------------------------------------------------
    const { data: todaysCompletions } = await supabase
      .from('request_entities')
      .select(
        'id, completed_at, request_id, ' +
        'requests!inner(id, client_id, intake_method, ' +
        'clients!inner(id, name, slug, free_trial, billing_rate_pdf, billing_rate_csv, ' +
        'billing_model, subscription_monthly_amount, subscription_included_entities, subscription_overage_rate))'
      )
      .eq('status', 'completed')
      .gte('completed_at', todayISO)
      .not('requests.clients.slug', 'ilike', '%-sandbox') as { data: any[] | null };

    // Group today's completions by client so we can apply per-client billing logic.
    type ClientBucket = {
      client_id: string;
      client_name: string;
      free_trial: boolean;
      rate_pdf: number;
      rate_csv: number;
      billing_model: 'per_tin' | 'subscription';
      subscription_monthly_amount: number | null;
      subscription_included_entities: number | null;
      subscription_overage_rate: number | null;
      entries: { id: string; intake: string; completed_at: string }[];
    };
    const byClient = new Map<string, ClientBucket>();
    for (const e of (todaysCompletions || [])) {
      const r = e.requests;
      const c = r?.clients;
      if (!c) continue;
      const bucket: ClientBucket = byClient.get(c.id) ?? {
        client_id: c.id,
        client_name: c.name,
        free_trial: !!c.free_trial,
        rate_pdf: c.billing_rate_pdf ?? 79.98,
        rate_csv: c.billing_rate_csv ?? 79.98,
        billing_model: (c.billing_model === 'subscription' ? 'subscription' : 'per_tin'),
        subscription_monthly_amount: c.subscription_monthly_amount ?? null,
        subscription_included_entities: c.subscription_included_entities ?? null,
        subscription_overage_rate: c.subscription_overage_rate ?? null,
        entries: [],
      };
      bucket.entries.push({ id: e.id, intake: r.intake_method, completed_at: e.completed_at });
      byClient.set(c.id, bucket);
    }

    // For free-trial clients: identify first-3 all-time completions (free carveout).
    const freeTrialClientIds = Array.from(byClient.values()).filter(b => b.free_trial).map(b => b.client_id);
    const freeIdsByClient = new Map<string, Set<string>>();
    if (freeTrialClientIds.length > 0) {
      const { data: allTime } = await supabase
        .from('request_entities')
        .select('id, completed_at, requests!inner(client_id)')
        .in('requests.client_id', freeTrialClientIds)
        .eq('status', 'completed')
        .not('completed_at', 'is', null) as { data: any[] | null };
      const perClient = new Map<string, { id: string; completed_at: string }[]>();
      for (const e of (allTime || [])) {
        const cid = e.requests?.client_id;
        if (!cid) continue;
        const arr = perClient.get(cid) ?? [];
        arr.push({ id: e.id, completed_at: e.completed_at });
        perClient.set(cid, arr);
      }
      for (const [cid, arr] of perClient) {
        arr.sort((a, b) => new Date(a.completed_at).getTime() - new Date(b.completed_at).getTime());
        freeIdsByClient.set(cid, new Set(arr.slice(0, 3).map(x => x.id)));
      }
    }

    // For subscription clients: pull all month-to-date completions so we know
    // which of today's entities cross the subscription_included threshold.
    const subscriptionClientIds = Array.from(byClient.values())
      .filter(b => b.billing_model === 'subscription')
      .map(b => b.client_id);
    const monthStart = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1).toISOString();
    const mtdByClient = new Map<string, { id: string; completed_at: string }[]>();
    if (subscriptionClientIds.length > 0) {
      const { data: mtd } = await supabase
        .from('request_entities')
        .select('id, completed_at, requests!inner(client_id)')
        .in('requests.client_id', subscriptionClientIds)
        .eq('status', 'completed')
        .gte('completed_at', monthStart) as { data: any[] | null };
      for (const e of (mtd || [])) {
        const cid = e.requests?.client_id;
        if (!cid) continue;
        const arr = mtdByClient.get(cid) ?? [];
        arr.push({ id: e.id, completed_at: e.completed_at });
        mtdByClient.set(cid, arr);
      }
      for (const arr of mtdByClient.values()) {
        arr.sort((a, b) => new Date(a.completed_at).getTime() - new Date(b.completed_at).getTime());
      }
    }

    let revenueToday = 0;
    let freeTrialEntitiesToday = 0;
    const revenueBreakdown: AdminDailySummaryStats['revenue_breakdown'] = [];

    for (const b of byClient.values()) {
      // ---------- SUBSCRIPTION CLIENT ----------
      if (b.billing_model === 'subscription') {
        const included = b.subscription_included_entities ?? 0;
        const overageRate = b.subscription_overage_rate ?? 0;
        const mtd = mtdByClient.get(b.client_id) ?? [];
        const todaysIds = new Set(b.entries.map(e => e.id));

        // Each MTD entity is either included (its ordinal position ≤ included)
        // or overage. Sum overage $ contributed by today's entities only.
        let overageFromToday = 0;
        mtd.forEach((entity, idx) => {
          const ordinal = idx + 1; // 1-indexed
          if (ordinal > included && todaysIds.has(entity.id)) {
            overageFromToday += overageRate;
          }
        });
        overageFromToday = Math.round(overageFromToday * 100) / 100;

        revenueToday += overageFromToday;
        revenueBreakdown.push({
          client_name: `${b.client_name} (subscription: ${mtd.length}/${included} MTD)`,
          billable_entities: b.entries.length,
          free_entities: 0,
          amount: overageFromToday,
        });
        continue;
      }

      // ---------- PER-TIN CLIENT ----------
      const freeSet = freeIdsByClient.get(b.client_id) ?? new Set<string>();
      let billable = 0;
      let free = 0;
      let amount = 0;
      for (const e of b.entries) {
        if (freeSet.has(e.id)) { free += 1; continue; }
        const rate = e.intake === 'csv' ? b.rate_csv : b.rate_pdf;
        amount += rate;
        billable += 1;
      }
      amount = Math.round(amount * 100) / 100;
      revenueToday += amount;
      freeTrialEntitiesToday += free;
      if (billable + free > 0) {
        revenueBreakdown.push({
          client_name: b.client_name,
          billable_entities: billable,
          free_entities: free,
          amount,
        });
      }
    }
    revenueToday = Math.round(revenueToday * 100) / 100;
    revenueBreakdown.sort((a, b) => b.amount - a.amount);

    // Compute daily COGS (infra + email + e-sign + voice + AI + payments + expert payouts)
    // Best-effort — if any sub-query fails the breakdown still renders with a warning.
    let cogs: AdminDailySummaryStats['cogs'];
    let margin: AdminDailySummaryStats['gross_margin'];
    try {
      // dayEndUtc = todayStart + 24h, locked to the same business-day window
      // used everywhere else in this file (Pacific midnight).
      const dayEndUtc = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000).toISOString();
      cogs = await computeDailyCogs(supabase, todayISO, dayEndUtc, revenueToday);
      margin = grossMargin(revenueToday, cogs.total);
    } catch (err) {
      console.error('[admin-daily-summary] COGS computation failed:', err);
      // Leave cogs/margin undefined; email template handles the absence.
    }

    const stats: AdminDailySummaryStats = {
      new_requests_today: newRequestsToday || 0,
      completions_today: completionsToday || 0,
      failures_today: failuresToday || 0,
      expert_completions_today: expertCompletionsToday || 0,
      active_requests: activeRequests || 0,
      expert_sla_compliance: slaCompliance,
      total_entities_completed_today: entitiesCompletedToday || 0,
      total_entities_pending: entitiesPending || 0,
      revenue_today: revenueToday,
      free_trial_entities_today: freeTrialEntitiesToday,
      revenue_breakdown: revenueBreakdown,
      cogs,
      gross_margin: margin,
    };

    // Skip sending if there is zero activity today
    const hasActivity =
      stats.new_requests_today > 0 ||
      stats.completions_today > 0 ||
      stats.failures_today > 0 ||
      stats.expert_completions_today > 0;

    if (!hasActivity) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'No activity today',
        processedAt: new Date().toISOString(),
      });
    }

    // Send to all admins
    let emailsSent = 0;
    const errors: { email: string; error: string }[] = [];

    for (const admin of admins) {
      try {
        await sendAdminDailySummary(admin.email, stats, dateLabel);
        emailsSent++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.error(`Failed to send admin summary to ${admin.email}:`, msg);
        errors.push({ email: admin.email, error: msg });
      }
    }

    return NextResponse.json({
      success: true,
      emailsSent,
      totalAdmins: admins.length,
      stats,
      processedAt: new Date().toISOString(),
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Admin daily summary cron error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Cron job failed', details: errorMessage },
      { status: 500 }
    );
  }
}
