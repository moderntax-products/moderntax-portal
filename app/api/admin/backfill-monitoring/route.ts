/**
 * POST /api/admin/backfill-monitoring
 *
 * One-time backfill: enroll EVERY completed entity in continuous monitoring,
 * across all clients (or a single client if narrowed). Idempotent — uses
 * autoEnrollMonitoring() which silently skips entities already on a
 * subscription. Respects per-client opt-out (clients.monitoring_default_enabled).
 *
 * Invoked by Matt once after the migration lands. After the initial backfill,
 * the daily auto-enroll-monitoring cron + the per-completion hook in
 * upload-transcript ensure no entity slips through.
 *
 * Auth: admin only.
 *
 * Body (all optional):
 *   { clientId?: string,    // narrow to one client
 *     dryRun?: boolean,     // count what would happen, don't enroll
 *     limit?: number }      // safety cap (default 5000)
 *
 * Response:
 *   { eligible, enrolled, skipped, by_client: [{client_id, name, enrolled, skipped}] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { autoEnrollMonitoring } from '@/lib/repeat-entity';
import { logAuditFromRequest } from '@/lib/audit';
import { requireBearer } from '@/lib/auth-util';

export async function POST(request: NextRequest) {
  try {
    // Auth — admin only OR cron secret (so we can also run this from a one-off
    // curl with the cron token in case Matt isn't logged in).
    const isCron = !requireBearer(request, process.env.CRON_SECRET);
    let userId = 'cron';
    let userEmail = '';

    if (!isCron) {
      const cookieStore = await cookies();
      const supabase = createServerRouteClient(cookieStore);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      const adminTmp = createAdminClient();
      const { data: profile } = await adminTmp
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single() as { data: { role: string } | null };
      if (!profile || profile.role !== 'admin') {
        return NextResponse.json({ error: 'Admin only' }, { status: 403 });
      }
      userId = user.id;
      userEmail = user.email || '';
    }

    const body = await request.json().catch(() => ({} as any));
    const narrowClientId = typeof body?.clientId === 'string' ? body.clientId : null;
    const dryRun = body?.dryRun === true;
    const limit = Math.min(typeof body?.limit === 'number' ? body.limit : 5000, 10000);

    const admin = createAdminClient();

    // Pull every completed entity that's NOT W2_INCOME, joined to its request
    // (for client_id) and to its client's monitoring opt-out flag. The query
    // fetches everything in one round-trip rather than per-entity lookups.
    let q = admin
      .from('request_entities')
      .select(`
        id, request_id, form_type, status,
        requests!inner(client_id, clients(id, name, monitoring_default_enabled))
      `)
      .eq('status', 'completed')
      .neq('form_type', 'W2_INCOME')
      .limit(limit);
    if (narrowClientId) q = q.eq('requests.client_id', narrowClientId);

    const { data: entities, error: qErr } = await q as { data: any[] | null; error: any };
    if (qErr) {
      console.error('[backfill-monitoring] query failed:', qErr);
      return NextResponse.json({ error: qErr.message }, { status: 500 });
    }

    if (!entities || entities.length === 0) {
      return NextResponse.json({ eligible: 0, enrolled: 0, skipped: 0, by_client: [] });
    }

    // Pre-fetch existing monitoring rows so we don't redundantly call
    // autoEnrollMonitoring (which would also short-circuit, but with an
    // extra round-trip per entity).
    const ids = entities.map((e: any) => e.id);
    const { data: monitored } = await admin
      .from('entity_monitoring')
      .select('entity_id')
      .in('entity_id', ids)
      .in('status', ['active', 'paused']) as { data: any[] | null };
    const alreadyMonitored = new Set((monitored || []).map((m: any) => m.entity_id));

    // Pre-bucket by client + apply opt-out filter once. If a client has
    // monitoring_default_enabled=false, every entity for that client is
    // skipped — visible in the by_client report.
    const byClient: Record<string, { client_id: string; name: string; enrolled: number; skipped: number; reason?: string }> = {};
    let totalEligible = 0;
    let totalEnrolled = 0;
    let totalSkipped = 0;

    for (const ent of entities) {
      const clientId = ent.requests?.client_id;
      const clientName = ent.requests?.clients?.name || 'Unknown';
      const optedOut = ent.requests?.clients?.monitoring_default_enabled === false;
      if (!clientId) { totalSkipped++; continue; }

      byClient[clientId] = byClient[clientId] || { client_id: clientId, name: clientName, enrolled: 0, skipped: 0 };
      totalEligible++;

      if (optedOut) {
        totalSkipped++;
        byClient[clientId].skipped++;
        byClient[clientId].reason = 'client_opted_out';
        continue;
      }

      if (alreadyMonitored.has(ent.id)) {
        totalSkipped++;
        byClient[clientId].skipped++;
        continue;
      }

      if (dryRun) {
        totalEnrolled++;
        byClient[clientId].enrolled++;
        continue;
      }

      try {
        const ok = await autoEnrollMonitoring(admin as any, ent.id, ent.request_id, clientId, userId);
        if (ok) {
          totalEnrolled++;
          byClient[clientId].enrolled++;
        } else {
          totalSkipped++;
          byClient[clientId].skipped++;
        }
      } catch (err) {
        console.error(`[backfill-monitoring] enroll failed for ${ent.id}:`, err);
        totalSkipped++;
        byClient[clientId].skipped++;
      }
    }

    if (!dryRun) {
      await logAuditFromRequest(admin, request, {
        action: 'settings_changed',
        userId,
        userEmail,
        resourceType: 'client',
        resourceId: narrowClientId || 'all',
        details: {
          setting: 'monitoring_backfill',
          scope: 'admin_one_shot',
          eligible: totalEligible,
          enrolled: totalEnrolled,
          skipped: totalSkipped,
          dry_run: dryRun,
        },
      });
    }

    return NextResponse.json({
      success: true,
      dry_run: dryRun,
      eligible: totalEligible,
      enrolled: totalEnrolled,
      skipped: totalSkipped,
      by_client: Object.values(byClient),
    });
  } catch (err) {
    console.error('[backfill-monitoring] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
