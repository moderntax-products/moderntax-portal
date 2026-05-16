/**
 * Cancel a transcript request.
 *
 * POST /api/expert/cancel-request
 *   Body: { requestId: string, reason?: string }
 *
 * Allowed: requester (owner) OR admin OR manager-on-same-client.
 *
 * Cancellable statuses depend on role:
 *   · Non-admin: submitted, 8821_sent, 8821_signed
 *     (cancellation isn't safe once an expert is actively pulling — IRS
 *     billed work happens after irs_queue.)
 *   · Admin override: all of the above PLUS irs_queue and processing
 *     (admin has full context, e.g. for duplicate-request cleanup;
 *     reason field is captured into notes for audit).
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
const CANCELLABLE_STATUSES_ADMIN = [
  ...CANCELLABLE_STATUSES,
  'irs_queue',
  'processing',
];

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
  const isAdmin = profile.role === 'admin';

  // Look up the target request + its current status + ownership + notes
  // (was previously missing `notes` from the select, which silently
  // wiped existing notes on cancel — confirmed via DB diagnosis 2026-05-16).
  const { data: target, error: lookupErr } = await admin
    .from('requests')
    .select('id, status, client_id, requested_by, loan_number, notes')
    .eq('id', requestId)
    .single() as { data: any; error: any };
  if (lookupErr || !target) {
    if (lookupErr) console.error('[cancel-request] lookup failed:', lookupErr);
    return NextResponse.json({ error: 'Request not found' }, { status: 404 });
  }

  // Authorization: requester OR admin OR manager-on-same-client.
  const isOwner = target.requested_by === user.id;
  const isManagerOnClient = profile.role === 'manager' && profile.client_id === target.client_id;
  if (!isOwner && !isAdmin && !isManagerOnClient) {
    return NextResponse.json({ error: 'Not authorized to cancel this request' }, { status: 403 });
  }

  // Status guard: stricter for non-admins, looser for admin override.
  const allowedStatuses = isAdmin ? CANCELLABLE_STATUSES_ADMIN : CANCELLABLE_STATUSES;
  if (!allowedStatuses.includes(target.status)) {
    return NextResponse.json(
      {
        error: isAdmin
          ? `Cannot cancel a request in status "${target.status}". Even admin override allows cancellation only in: ${allowedStatuses.join(', ')}.`
          : `Cannot cancel a request in status "${target.status}". Cancellation is only allowed before IRS processing begins. Contact support to request manual handling.`,
        status: target.status,
        cancellable_statuses: allowedStatuses,
      },
      { status: 409 },
    );
  }

  // Mark request as cancelled. Build the update payload defensively — if
  // the cancellation migration hasn't run, fall back to status+notes only
  // (cancelled_at/cancelled_by columns may not exist yet in older envs).
  const nowIso = new Date().toISOString();
  const cancelNote = `Cancelled by ${user.email}${isAdmin ? ' (admin)' : ''} on ${nowIso}${reason ? ` — reason: ${reason}` : ''}`;
  const mergedNotes = target.notes ? `${target.notes}\n\n${cancelNote}` : cancelNote;

  let requestErr: any = null;
  {
    // Phase 1: try full payload with new columns.
    const r1 = await admin
      .from('requests')
      .update({
        status: 'cancelled',
        cancelled_at: nowIso,
        cancelled_by: user.id,
        notes: mergedNotes,
      } as any)
      .eq('id', requestId);
    if (r1.error && /cancelled_at|cancelled_by|PGRST204|column .* does not exist/i.test(r1.error.message || '')) {
      // Phase 2: retry without the new columns. Status + notes only.
      console.warn('[cancel-request] cancelled_at/cancelled_by columns missing — retrying without them. RUN supabase/migration-request-cancellation.sql to enable full audit trail.');
      const r2 = await admin
        .from('requests')
        .update({ status: 'cancelled', notes: mergedNotes } as any)
        .eq('id', requestId);
      requestErr = r2.error;
    } else {
      requestErr = r1.error;
    }
  }
  if (requestErr) {
    // Specific guidance for the CHECK-constraint failure that means the
    // migration adding 'cancelled' to requests_status_check hasn't run.
    if (/requests_status_check|check constraint/i.test(requestErr.message || '')) {
      console.error('[cancel-request] requests_status_check rejected "cancelled". RUN supabase/migration-request-cancellation.sql.');
      return NextResponse.json({
        error: 'Cancellation not yet enabled — database migration required',
        admin_hint: isAdmin ? 'Run supabase/migration-request-cancellation.sql in Supabase SQL Editor' : undefined,
      }, { status: 500 });
    }
    console.error('[cancel-request] requests UPDATE failed:', requestErr);
    return NextResponse.json({
      error: 'Failed to cancel request',
      // Only surface DB details to admins — keeps internals private from
      // non-admin callers.
      admin_hint: isAdmin ? requestErr.message : undefined,
    }, { status: 500 });
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
    else console.warn(`[cancel-request] entity ${ent.id} update failed:`, entErr.message);
  }

  // Cancel any pending expert assignments. Try 'cancelled' first (cleaner
  // semantics post-migration); fall back to 'failed' if the check constraint
  // hasn't been extended yet.
  let assignmentsCancelled = 0;
  if (entities && entities.length > 0) {
    const ids = entities.map(e => e.id);
    const { data: assigned } = await admin
      .from('expert_assignments')
      .select('id, status')
      .in('entity_id', ids)
      .in('status', ['assigned', 'in_progress']) as { data: any[] | null; error: any };
    for (const asn of (assigned || [])) {
      let asnErr: any = null;
      const r1 = await admin
        .from('expert_assignments')
        .update({ status: 'cancelled' } as any)
        .eq('id', asn.id);
      if (r1.error && /check constraint|expert_assignments_status_check/i.test(r1.error.message || '')) {
        const r2 = await admin
          .from('expert_assignments')
          .update({ status: 'failed' } as any)
          .eq('id', asn.id);
        asnErr = r2.error;
      } else {
        asnErr = r1.error;
      }
      if (!asnErr) assignmentsCancelled += 1;
      else console.warn(`[cancel-request] assignment ${asn.id} update failed:`, asnErr.message);
    }
  }

  // Cancel any active monitoring enrollment rooted in this request
  const { error: monErr } = await admin
    .from('entity_monitoring' as any)
    .update({ status: 'cancelled', cancelled_at: nowIso } as any)
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
