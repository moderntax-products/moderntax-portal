/**
 * POST /api/admin/expert-payout
 *
 * Drafts an APPROVAL-GATED Mercury payout for an approved expert pay period.
 * The money does NOT move here — Mercury creates a `pendingApproval` send-money
 * request that the admin approves in the Mercury app. We never touch bank
 * details (Mercury holds them on the recipient).
 *
 * Body: { period_id: string }  — an expert_pay_periods row (status 'approved').
 *
 * Flow: resolve the expert's Mercury recipient (stored id, else match by
 * name/email and store it; if none, 409 asking admin to invite them in
 * Mercury) → requestSendMoney(gross_pay) → record the request id/status.
 *
 * Auth: admin only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import {
  listMercuryRecipients, matchRecipient, createMercuryRecipient, getPayoutAccountId, requestSendMoney,
} from '@/lib/mercury';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const { data: caller } = await supabase.from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (!caller || caller.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 });

  const body = await request.json().catch(() => ({} as any));
  const periodId = body.period_id as string | undefined;
  if (!periodId) return NextResponse.json({ error: 'period_id is required' }, { status: 400 });

  if (!process.env.MERCURY_API_KEY) {
    return NextResponse.json({ error: 'MERCURY_API_KEY not configured' }, { status: 500 });
  }

  const admin = createAdminClient();

  const { data: period } = await admin
    .from('expert_pay_periods')
    .select('id, expert_id, gross_pay, status, payout_status, period_start, period_end, mercury_payout_request_id')
    .eq('id', periodId).single() as { data: any };
  if (!period) return NextResponse.json({ error: 'Pay period not found' }, { status: 404 });
  // Margin-guard gate: a zero-production period is blocked and can never pay out.
  if (period.payout_status === 'BLOCKED_ZERO_PRODUCTION' || period.status === 'blocked') {
    return NextResponse.json({ error: 'Payout blocked — zero verified units completed this period. No payout authorized.' }, { status: 400 });
  }
  if (period.status !== 'approved') {
    return NextResponse.json({ error: `Pay period must be 'approved' first (is '${period.status}')` }, { status: 400 });
  }
  if (period.mercury_payout_request_id) {
    return NextResponse.json({ error: 'A Mercury payout was already drafted for this period', detail: period.mercury_payout_request_id }, { status: 409 });
  }
  const amount = Number(period.gross_pay) || 0;
  if (amount <= 0) return NextResponse.json({ error: 'Pay period gross is $0 — nothing to pay' }, { status: 400 });

  // ── Client-payment gate (Matt's policy 2026-06-30): experts are paid AFTER
  //    the client revenue covering their work is collected. Hold the payout
  //    until every entity the expert completed this period is on a PAID client
  //    invoice — either a per-order invoice for that entity, or a paid monthly
  //    invoice for the client whose billing period covers the completion date.
  //    Admin can override with ?force=1 (or { force:true }).
  const force = request.nextUrl.searchParams.get('force') === '1' || body.force === true;
  if (!force) {
    const startIso = new Date(period.period_start).toISOString();
    const endIso = new Date(new Date(period.period_end).getTime() + 24 * 3600 * 1000).toISOString();
    const { data: doneAsn } = await admin.from('expert_assignments')
      .select('entity_id, completed_at')
      .eq('expert_id', period.expert_id).eq('status', 'completed')
      .gte('completed_at', startIso).lt('completed_at', endIso) as { data: any[] | null };
    const entityIds = [...new Set((doneAsn || []).map((a) => a.entity_id).filter(Boolean))];
    if (entityIds.length) {
      const { data: ents } = await admin.from('request_entities')
        .select('id, entity_name, requests!inner(client_id)').in('id', entityIds) as { data: any[] | null };
      const clientByEntity = new Map((ents || []).map((e: any) => [e.id, e.requests?.client_id]));
      const completedAt = new Map((doneAsn || []).map((a: any) => [a.entity_id, (a.completed_at || '').slice(0, 10)]));
      const clientIds = [...new Set([...clientByEntity.values()].filter(Boolean))] as string[];
      const { data: paidInv } = await admin.from('invoices')
        .select('client_id, entity_id, billing_period_start, billing_period_end')
        .in('client_id', clientIds).eq('status', 'paid') as { data: any[] | null };
      const funded = (eid: string) => {
        const cid = clientByEntity.get(eid);
        const day = completedAt.get(eid);
        return (paidInv || []).some((inv) =>
          inv.entity_id === eid ||
          (inv.client_id === cid && day && inv.billing_period_start <= day && day <= inv.billing_period_end));
      };
      const unfunded = entityIds.filter((eid) => !funded(eid));
      if (unfunded.length) {
        const names = (ents || []).filter((e: any) => unfunded.includes(e.id)).map((e: any) => e.entity_name);
        return NextResponse.json({
          error: 'Payout held — awaiting client payment',
          detail: `${unfunded.length} of ${entityIds.length} entities this expert completed are not yet on a PAID client invoice. Experts are paid once the client revenue is collected. Pass ?force=1 to override.`,
          unfunded_entities: names.slice(0, 10),
        }, { status: 409 });
      }
    }
  }

  const { data: expert } = await admin.from('profiles')
    .select('id, full_name, email, mercury_recipient_id, w9_url').eq('id', period.expert_id).single() as { data: any };
  if (!expert) return NextResponse.json({ error: 'Expert not found' }, { status: 404 });

  // Resolve the Mercury recipient — match existing, else AUTO-CREATE (Mercury
  // then collects the expert's bank details directly; we never store them).
  let recipientId: string | null = expert.mercury_recipient_id || null;
  if (!recipientId) {
    if (!expert.email) {
      return NextResponse.json({ error: 'Expert has no email — cannot create a Mercury recipient' }, { status: 400 });
    }
    try {
      const recips = await listMercuryRecipients();
      const m = matchRecipient(recips, expert.full_name, expert.email);
      const r = m || await createMercuryRecipient(expert.full_name || expert.email, expert.email);
      recipientId = r.id;
      await (admin.from('profiles' as any) as any).update({ mercury_recipient_id: r.id }).eq('id', expert.id);
    } catch (e: any) {
      return NextResponse.json({ error: 'Could not resolve/create Mercury recipient', detail: e?.message }, { status: 502 });
    }
  }

  // Draft the approval-gated send-money request.
  let result: any;
  try {
    const accountId = await getPayoutAccountId();
    result = await requestSendMoney(accountId, {
      recipientId,
      amount,
      note: `ModernTax expert payout — ${String(period.period_start).slice(0, 10)} to ${String(period.period_end).slice(0, 10)}`,
      idempotencyKey: `payout-${period.id}`,
    });
  } catch (e: any) {
    return NextResponse.json({ error: 'Mercury send-money request failed', detail: e?.message }, { status: 502 });
  }

  await (admin.from('expert_pay_periods' as any) as any).update({
    mercury_payout_request_id: result?.id || null,
    mercury_payout_status: result?.status || 'pendingApproval',
    mercury_payout_drafted_at: new Date().toISOString(),
  }).eq('id', period.id);

  return NextResponse.json({
    success: true,
    period_id: period.id,
    amount,
    recipient_id: recipientId,
    mercury_request_id: result?.id || null,
    mercury_status: result?.status || 'pendingApproval',
    w9_on_file: !!expert.w9_url,
    note: 'Drafted in Mercury — approve it in the Mercury app to release the payment. No money has moved.',
  });
}
