/**
 * POST /api/team/bulk-enroll-monitoring
 *
 * Manager-only: enroll every completed entity on the client into continuous
 * monitoring in one shot. The "Bulk-enroll N now" CTA on the manager
 * dashboard's Upgrade-Your-Team panel calls this.
 *
 * Body: { clientId: string }
 *
 * Auth: manager (own client only) or admin.
 *
 * Behavior: re-uses autoEnrollMonitoring() from lib/repeat-entity (idempotent
 * — silently skips entities already on a monitoring subscription). W2_INCOME
 * entities are excluded (they're transient W&I docs).
 *
 * Returns: { enrolled: N, skipped: N, eligible: N }
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { autoEnrollMonitoring } from '@/lib/repeat-entity';
import { logAuditFromRequest } from '@/lib/audit';

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const admin = createAdminClient();
    const { data: profile } = await admin
      .from('profiles')
      .select('role, client_id')
      .eq('id', user.id)
      .single() as { data: { role: string; client_id: string | null } | null; error: any };

    if (!profile || !['admin', 'manager'].includes(profile.role)) {
      return NextResponse.json({ error: 'Manager or admin only' }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const clientId = typeof body?.clientId === 'string' ? body.clientId : null;
    if (!clientId) return NextResponse.json({ error: 'clientId required' }, { status: 400 });
    if (profile.role !== 'admin' && clientId !== profile.client_id) {
      return NextResponse.json({ error: 'Cannot bulk-enroll for another client' }, { status: 403 });
    }

    // Eligible entities = status=completed AND NOT already monitored AND NOT W2_INCOME.
    // Use the join to get only entities under this client.
    const { data: completedEntities } = await admin
      .from('request_entities')
      .select('id, request_id, requests!inner(client_id)')
      .eq('requests.client_id', clientId)
      .eq('status', 'completed')
      .neq('form_type', 'W2_INCOME') as { data: any[] | null };

    if (!completedEntities || completedEntities.length === 0) {
      return NextResponse.json({ enrolled: 0, skipped: 0, eligible: 0 });
    }

    // Pre-fetch existing monitoring rows so we can short-circuit before calling
    // the per-row enroll function (saves ~N round trips on a large bulk).
    const ids = completedEntities.map((e: any) => e.id);
    const { data: monitored } = await admin
      .from('entity_monitoring')
      .select('entity_id')
      .in('entity_id', ids)
      .in('status', ['active', 'paused']) as { data: any[] | null };
    const alreadyMonitored = new Set((monitored || []).map((m: any) => m.entity_id));

    let enrolled = 0;
    let skipped = 0;
    for (const ent of completedEntities) {
      if (alreadyMonitored.has(ent.id)) {
        skipped++;
        continue;
      }
      try {
        const ok = await autoEnrollMonitoring(
          admin as any,
          ent.id,
          ent.request_id,
          clientId,
          user.id,
        );
        if (ok) enrolled++;
        else skipped++;
      } catch (err) {
        console.error(`[bulk-enroll] failed for ${ent.id}:`, err);
        skipped++;
      }
    }

    await logAuditFromRequest(admin, request, {
      action: 'settings_changed',
      userId: user.id,
      userEmail: user.email || '',
      resourceType: 'client',
      resourceId: clientId,
      details: {
        setting: 'monitoring_bulk_enroll',
        scope: 'team_upgrade',
        eligible: completedEntities.length,
        enrolled,
        skipped,
      },
    });

    return NextResponse.json({
      success: true,
      eligible: completedEntities.length,
      enrolled,
      skipped,
    });
  } catch (err) {
    console.error('bulk-enroll-monitoring error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
