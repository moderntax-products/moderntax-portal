/**
 * Mark a pending mid-call fax as actually sent.
 *
 * POST /api/expert/irs-call/mark-fax-sent
 *   Body: { call_entity_id: string }
 *
 * Called by the live-call UI when the listening expert has manually fired
 * the 8821 fax (their fax machine, eFax, whatever). Flips the entity's
 * outcome from 'fax_pending_manual' → 'fax_sent' so the banner clears.
 *
 * The AI on the call doesn't need to know about this directly — it
 * already told the IRS the fax was sent and is silently waiting for IRS
 * to confirm receipt ("got it" / "received"). When that happens the AI
 * fires update_entity_status(event="fax_received") which is a separate
 * status transition.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null };
  if (!profile || !['expert', 'admin'].includes(profile.role)) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const callEntityId: string | undefined = body.call_entity_id;
  if (!callEntityId) {
    return NextResponse.json({ error: 'call_entity_id required' }, { status: 400 });
  }

  const admin = createAdminClient();

  // Verify the entity belongs to a session this expert is on (RLS would
  // catch admin escalation but we belt-and-suspender it explicitly).
  const { data: callEntity, error: lookupErr } = await (admin.from('irs_call_entities' as any) as any)
    .select('id, call_session_id, taxpayer_name, fax_number_used, irs_call_sessions(expert_id)')
    .eq('id', callEntityId)
    .single();
  if (lookupErr || !callEntity) {
    return NextResponse.json({ error: 'Call entity not found' }, { status: 404 });
  }
  const ownerId = (callEntity as any).irs_call_sessions?.expert_id;
  if (profile.role !== 'admin' && ownerId !== user.id) {
    return NextResponse.json({ error: 'Not authorized for this fax' }, { status: 403 });
  }

  const { error: updateErr } = await (admin.from('irs_call_entities' as any) as any)
    .update({
      fax_sent: true,
      outcome: 'fax_sent',
      outcome_notes: `8821 manually faxed by ${user.email} at ${new Date().toISOString()} — number ${callEntity.fax_number_used}`,
    })
    .eq('id', callEntityId);

  if (updateErr) {
    console.error('[mark-fax-sent] update failed:', updateErr.message);
    return NextResponse.json({ error: 'Failed to mark fax sent' }, { status: 500 });
  }

  await logAuditFromRequest(admin, request, {
    action: 'irs_call_initiated', // closest existing action; could add a dedicated 'irs_fax_sent' later
    userId: user.id,
    userEmail: user.email || '',
    resourceType: 'irs_call_entity',
    resourceId: callEntityId,
    details: {
      manual_fax_sent: true,
      taxpayer_name: callEntity.taxpayer_name,
      fax_number: callEntity.fax_number_used,
    },
  });

  return NextResponse.json({ success: true });
}
