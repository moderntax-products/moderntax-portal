/**
 * POST /api/billing/check-reissue-request
 *
 * NO-AUTH endpoint — anonymous prospects landing on the public ERC sample
 * (/sample-transcripts/erc-report) can request the $1,000 IRS check-reissue
 * recovery service WITHOUT first creating a portal account.
 *
 * Billing model: Mercury ACH (manual invoice from Matt). We don't take a
 * card up front — Stripe's 2.9% + $0.30 cuts too far into the margin on
 * a $1,000 multi-week service, and ERC-recovery customers prefer ACH
 * invoicing on this size of transaction. The endpoint just captures the
 * request + emails Matt; he opens Mercury, sends the invoice, and the
 * customer pays via ACH from their business banking.
 *
 * Body:
 *   {
 *     email:        string  (required) — where Mercury will send the invoice
 *     businessName: string  (required) — recipient name on the Mercury invoice
 *     ein?:         string             — for our records
 *     refundQuarter?: string           — e.g. "2020 Q4"
 *     refundAmount?:  number           — the dollar amount of the returned check
 *     notes?:         string           — anything the customer wants to add
 *   }
 *
 * Response: { ok: true, message: string }
 *
 * Security: rate-limited by basic input validation (required fields + email
 * format). The worst a malicious caller can do is spam Matt's inbox; the
 * endpoint never charges anyone or creates portal records.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sendCheckReissueRequestNotification } from '@/lib/sendgrid';

interface CheckReissueRequestBody {
  email?: string;
  businessName?: string;
  ein?: string;
  refundQuarter?: string;
  refundAmount?: number;
  notes?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  let body: CheckReissueRequestBody | null;
  try {
    body = (await request.json()) as CheckReissueRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const email = (body?.email || '').trim();
  const businessName = (body?.businessName || '').trim();

  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: 'A valid email address is required so we can send the Mercury ACH invoice.' },
      { status: 400 },
    );
  }
  if (!businessName) {
    return NextResponse.json(
      { error: 'Business name is required (Mercury invoices are made out to the business).' },
      { status: 400 },
    );
  }

  // Sanity caps on free-text fields so a bad actor can't compose a giant
  // email body. These are generous — real submissions are tiny.
  const ein = (body?.ein || '').trim().slice(0, 32) || null;
  const refundQuarter = (body?.refundQuarter || '').trim().slice(0, 32) || undefined;
  const notes = (body?.notes || '').trim().slice(0, 2000) || null;
  const refundAmount = typeof body?.refundAmount === 'number' && Number.isFinite(body.refundAmount)
    ? Math.max(0, Math.min(body.refundAmount, 10_000_000))
    : undefined;

  await sendCheckReissueRequestNotification({
    source: 'public_sample',
    customerEmail: email,
    businessName: businessName.slice(0, 200),
    refundContext: {
      quarter: refundQuarter,
      refundAmount,
      ein,
      notes,
    },
  });

  return NextResponse.json({
    ok: true,
    message: `Thanks — we'll send a Mercury ACH invoice for $1,000 to ${email} within 1 business day. Once it's paid we file Form 8822-B and call the IRS Business & Specialty Tax line on the client's behalf.`,
  });
}
