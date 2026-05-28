/**
 * POST /api/team/upgrade-toggles
 *
 * Manager-only: flip a per-client add-on toggle.
 *
 * Body: { clientId: string, flag: 'monitoring_default_enabled' | 'cash_flow_auto_attach', value: boolean }
 *
 * Auth: manager (own client) or admin. Processors are blocked — they can ask
 * their manager via the dashboard mailto CTA.
 *
 * Side effect: writes the boolean to clients.<flag>. Does NOT cancel existing
 * monitoring enrollments when monitoring_default_enabled flips to false —
 * only future auto-enrolls are affected.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';

const ALLOWED_FLAGS = ['monitoring_default_enabled', 'cash_flow_auto_attach'] as const;
type AllowedFlag = (typeof ALLOWED_FLAGS)[number];

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
    const flag = body?.flag as AllowedFlag;
    const value = !!body?.value;

    if (!clientId) return NextResponse.json({ error: 'clientId required' }, { status: 400 });
    if (!ALLOWED_FLAGS.includes(flag)) {
      return NextResponse.json({ error: `flag must be one of ${ALLOWED_FLAGS.join(', ')}` }, { status: 400 });
    }

    // Non-admins can only toggle their own client.
    if (profile.role !== 'admin' && clientId !== profile.client_id) {
      return NextResponse.json({ error: 'Cannot modify another client' }, { status: 403 });
    }

    const { error } = await admin
      .from('clients')
      .update({ [flag]: value })
      .eq('id', clientId);

    if (error) {
      console.error('[team/upgrade-toggles] update failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await logAuditFromRequest(admin, request, {
      action: 'settings_changed',
      userId: user.id,
      userEmail: user.email || '',
      resourceType: 'client',
      resourceId: clientId,
      details: { setting: flag, value, set_by_role: profile.role, scope: 'team_upgrade_toggle' },
    });

    return NextResponse.json({ success: true, flag, value });
  } catch (err) {
    console.error('upgrade-toggles error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
