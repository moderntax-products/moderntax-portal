/**
 * POST /api/admin/check-reissue
 *
 * Creates a check_reissue_requests row when an admin clicks "Request
 * Check Reissue" on the ERC report. This kicks off the premium recovery
 * workflow (Form 8822-B + IRS Business & Specialty Tax call) billed at
 * PRICE_CHECK_REISSUE per check.
 *
 * Billing model: Mercury ACH (manual invoice from Matt). After the row
 * is created, we email matt@moderntax.io with the entity context so he
 * can send a Mercury invoice from the dashboard. NO Stripe redirect —
 * the $1,000 fee + multi-week service runs better on ACH than card.
 *
 * Body:
 *   {
 *     entity_id:        UUID,
 *     tax_year:         number,
 *     tax_quarter:      1|2|3|4,
 *     original_refund_amount?: number,
 *     original_refund_date?:   'YYYY-MM-DD',
 *     returned_undelivered_date?: 'YYYY-MM-DD',
 *     notes?:           string,
 *   }
 *
 * Idempotent: the (entity_id, tax_year, tax_quarter) unique partial
 * index on the table means a second POST for the same quarter returns
 * the existing row's id instead of creating a duplicate.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { PRICE_CHECK_REISSUE } from '@/lib/pricing';
import { sendCheckReissueRequestNotification } from '@/lib/sendgrid';

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const sessionClient = createServerRouteClient(cookieStore);
  const { data: { user } } = await sessionClient.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null };
  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }

  let body: any;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const {
    entity_id,
    tax_year,
    tax_quarter,
    original_refund_amount,
    original_refund_date,
    returned_undelivered_date,
    notes,
  } = body;

  if (!entity_id || !Number.isFinite(tax_year) || !Number.isFinite(tax_quarter)) {
    return NextResponse.json(
      { error: 'entity_id, tax_year, tax_quarter are required' },
      { status: 400 },
    );
  }
  if (tax_quarter < 1 || tax_quarter > 4) {
    return NextResponse.json({ error: 'tax_quarter must be 1-4' }, { status: 400 });
  }

  // Resolve request_id + client_id from the entity so the caller doesn't
  // have to pass them (the entity is the only required handle).
  // We also pull entity_name + client name + signer_email for the
  // Mercury invoice notification we'll send below.
  const { data: entity } = await admin
    .from('request_entities')
    .select('id, request_id, entity_name, signer_email, requests(client_id, clients(name, billing_email))')
    .eq('id', entity_id)
    .single() as { data: { id: string; request_id: string; entity_name: string | null; signer_email: string | null; requests: any } | null };
  if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
  const client_id = entity.requests?.client_id;
  if (!client_id) return NextResponse.json({ error: 'Entity has no client linkage' }, { status: 500 });

  // Idempotency — if an active request exists for this quarter, return it.
  const { data: existing } = await admin
    .from('check_reissue_requests' as any)
    .select('id, status')
    .eq('entity_id', entity_id)
    .eq('tax_year', tax_year)
    .eq('tax_quarter', tax_quarter)
    .not('status', 'in', '("cancelled","failed")')
    .maybeSingle() as { data: any };
  if (existing) {
    return NextResponse.json({ id: existing.id, status: existing.status, deduped: true });
  }

  const { data: created, error } = await (admin
    .from('check_reissue_requests' as any) as any)
    .insert({
      entity_id,
      request_id: entity.request_id,
      client_id,
      tax_year,
      tax_quarter,
      original_refund_amount: original_refund_amount ?? null,
      original_refund_date: original_refund_date || null,
      returned_undelivered_date: returned_undelivered_date || null,
      service_fee: PRICE_CHECK_REISSUE,
      status: 'requested',
      requested_by: user.id,
      notes: notes || null,
    })
    .select('id, status, service_fee')
    .single();

  if (error || !created) {
    console.error('[check-reissue] insert failed:', error);
    return NextResponse.json(
      { error: 'Failed to create reissue request', details: error?.message },
      { status: 500 },
    );
  }

  await logAuditFromRequest(admin, request, {
    action: 'check_reissue_requested',
    userId: user.id,
    userEmail: user.email || '',
    resourceType: 'check_reissue_request',
    resourceId: created.id,
    details: {
      entity_id,
      tax_year,
      tax_quarter,
      service_fee: PRICE_CHECK_REISSUE,
      original_refund_amount,
    },
  });

  // Notify Matt — he creates the Mercury ACH invoice in the dashboard.
  // Best-effort: a SendGrid failure must NOT block the request creation
  // (the row + audit log are the source of truth).
  const clientRow = entity.requests?.clients;
  const customerEmail = clientRow?.billing_email || entity.signer_email || user.email || '';
  if (customerEmail) {
    await sendCheckReissueRequestNotification({
      source: 'admin_portal',
      customerEmail,
      businessName: entity.entity_name || clientRow?.name || 'Unknown business',
      refundContext: {
        quarter: `${tax_year} Q${tax_quarter}`,
        refundAmount: typeof original_refund_amount === 'number' ? original_refund_amount : undefined,
        refundDate: original_refund_date || null,
        returnedDate: returned_undelivered_date || null,
        notes: notes || null,
      },
      internalContext: {
        checkReissueId: created.id,
        entityId: entity.id,
        entityName: entity.entity_name || undefined,
        clientName: clientRow?.name || undefined,
        requestedByEmail: user.email || undefined,
      },
    });
  } else {
    console.warn('[check-reissue] no customer email resolvable for entity', entity_id, '— skipping Mercury notification');
  }

  return NextResponse.json({
    id: created.id,
    status: created.status,
    service_fee: created.service_fee,
    deduped: false,
    billing: 'mercury_ach',
    message: 'Mercury ACH invoice will be sent within 1 business day.',
  });
}
