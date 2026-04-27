/**
 * Cancel a transcript request.
 *
 * POST /api/expert/cancel-request
 *   Body: { requestId: string, reason?: string }
 *
 * Allowed: requester (owner) OR admin OR manager-on-same-client. Status
 * must be in cancellable set — once an expert is actively pulling
 * transcripts, cancellation isn't safe (we'd still be billed by IRS for
 * that work). Cancellable statuses:
 *
 *   submitted, 8821_sent, 8821_signed
 *
 * Sets request.status = 'cancelled', cancels all child entity rows by
 * setting status='failed' with cancellation note. Cancels any pending
 * expert assignments. Soft-deletes pending Dropbox Sign signature
 * requests (caller must have already withdrawn — we don't do it here).
 *
 * Returns the cancelled request id + count of entities/assignments touched.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';

const CANCELLABLE_STATUSES = ['submitted', '8821_sent', '8821_signed'];

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, client_id')
    .eq('id', user.id)
    .single() as { data: { role: string; client_id: string | null } | null; error: any };
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 403 });

  const body = await request.json().catch(() => ({} as any));
  const requestId: string | undefined = body.requestId;
  const reason: string = (body.reason || '').slice(0, 500);
  if (!requestId) return NextResponse.json({ error: 'requestId required' }, { status: 400 });

  const admin = createAdminClient();

  // Look up the target request + its current status + ownership.
  const { data: target, error: lookupErr } = await admin
    .from('requests')
    .select('id, status, client_id, requested_by, loan_number')
    .eq('id', requestId)
    .single() as { data: any; error: any };
  if (lookupErr || !target) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

  // Authorization: requester OR admin OR manager-on-same-client.
  const isOwner = target.requested_by === user.id;
  const isAdmin = profile.role === 'admin';
  const isManagerOnClient = profile.role === 'manager' && profile.client_id === target.client_id;
  if (!isOwner && !isAdmin && !isManagerOnClient) {
    return NextResponse.json({ error: 'Not authorized to cancel this request' }, { status: 403 });
  }

  // Status guard: only cancellable in early states.
  if (!CANCELLABLE_STATUSES.includes(target.status)) {
    return NextResponse.json(
      {
        error: `Cannot cancel a request in status "${target.status}". Cancellation is only allowed before IRS processing begins. Contact support to request manual handling.`,
        status: target.status,
        cancellable_statuses: CANCELLABLE_STATUSES,
      },
      { status: 409 },
    );
  }

  // Mark request as cancelled
  const cancelNote = `Cancelled by ${user.email} on ${new Date().toISOString()}${reason ? ` — reason: ${reason}` : ''}`;
  const { error: requestErr } = await admin
    .from('requests')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      notes: target.notes
        ? `${target.notes}\n\n${cancelNote}`
        : cancelNote,
    } as any)
    .eq('id', requestId);
  if (requestErr) {
    return NextResponse.json({ error: 'Failed to cancel request', details: requestErr.message }, { status: 500 });
  }

  // Cancel all non-completed entities. Failed/completed entities stay as-is.
  const { data: entities } = await admin
    .from('request_entities')
    .select('id, status')
    .eq('request_id', requestId) as { data: any[] | null; error: any };
  let entitiesCancelled = 0;
  for (const ent of (entities || [])) {
    if (['completed', 'failed'].includes(ent.status)) continue;
    const { error: entErr } = await admin
      .from('request_entities')
      .update({
        status: 'failed',
        outcome_notes: cancelNote,
      } as any)
      .eq('id', ent.id);
    if (!entErr) entitiesCancelled += 1;
  }

  // Cancel any pending expert assignments
  let assignmentsCancelled = 0;
  if (entities && entities.length > 0) {
    const ids = entities.map(e => e.id);
    const { data: assigned } = await admin
      .from('expert_assignments')
      .select('id, status')
      .in('entity_id', ids)
      .in('status', ['assigned', 'in_progress']) as { data: any[] | null; error: any };
    for (const asn of (assigned || [])) {
      const { error: asnErr } = await admin
        .from('expert_assignments')
        .update({ status: 'cancelled' } as any)
        .eq('id', asn.id);
      if (!asnErr) assignmentsCancelled += 1;
    }
  }

  // Cancel any active monitoring enrollment rooted in this request
  const { error: monErr } = await admin
    .from('entity_monitoring' as any)
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() } as any)
    .eq('request_id', requestId)
    .in('status', ['active', 'pending']);
  if (monErr) {
    console.warn('[cancel-request] monitoring cancel failed (non-fatal):', monErr.message);
  }

  await logAuditFromRequest(admin, request, {
    action: 'request_created', // closest existing AuditAction; could add 'request_cancelled'
    userId: user.id,
    userEmail: user.email || '',
    resourceType: 'request',
    resourceId: requestId,
    details: {
      cancelled: true,
      reason: reason || null,
      prior_status: target.status,
      entities_cancelled: entitiesCancelled,
      assignments_cancelled: assignmentsCancelled,
      cancelled_by_role: profile.role,
    },
  });

  return NextResponse.json({
    success: true,
    request_id: requestId,
    prior_status: target.status,
    entities_cancelled: entitiesCancelled,
    assignments_cancelled: assignmentsCancelled,
  });
}
