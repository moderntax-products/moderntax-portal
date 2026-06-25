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
  listMercuryRecipients, matchRecipient, getPayoutAccountId, requestSendMoney,
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
    .select('id, expert_id, gross_pay, status, period_start, period_end, mercury_payout_request_id')
    .eq('id', periodId).single() as { data: any };
  if (!period) return NextResponse.json({ error: 'Pay period not found' }, { status: 404 });
  if (period.status !== 'approved') {
    return NextResponse.json({ error: `Pay period must be 'approved' first (is '${period.status}')` }, { status: 400 });
  }
  if (period.mercury_payout_request_id) {
    return NextResponse.json({ error: 'A Mercury payout was already drafted for this period', detail: period.mercury_payout_request_id }, { status: 409 });
  }
  const amount = Number(period.gross_pay) || 0;
  if (amount <= 0) return NextResponse.json({ error: 'Pay period gross is $0 — nothing to pay' }, { status: 400 });

  const { data: expert } = await admin.from('profiles')
    .select('id, full_name, email, mercury_recipient_id, w9_url').eq('id', period.expert_id).single() as { data: any };
  if (!expert) return NextResponse.json({ error: 'Expert not found' }, { status: 404 });

  // Resolve the Mercury recipient.
  let recipientId: string | null = expert.mercury_recipient_id || null;
  if (!recipientId) {
    try {
      const recips = await listMercuryRecipients();
      const m = matchRecipient(recips, expert.full_name, expert.email);
      if (m) {
        recipientId = m.id;
        await (admin.from('profiles' as any) as any).update({ mercury_recipient_id: m.id }).eq('id', expert.id);
      }
    } catch (e: any) {
      return NextResponse.json({ error: 'Could not reach Mercury to resolve recipient', detail: e?.message }, { status: 502 });
    }
  }
  if (!recipientId) {
    return NextResponse.json({
      error: 'No Mercury recipient on file for this expert',
      detail: `Invite ${expert.full_name || expert.email} as a recipient in Mercury (they add their own bank details), then draft the payout again.`,
      code: 'no_recipient',
    }, { status: 409 });
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
