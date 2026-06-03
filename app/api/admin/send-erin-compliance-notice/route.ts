/**
 * POST /api/admin/send-erin-compliance-notice
 *
 * One-off: sends Erin Wilsey (Banc of California) the transactional
 * notification that her ORR Inc Tax Compliance Report is live in the portal,
 * scheduled for delivery at the next 8:00 AM ET via SendGrid's send_at.
 * Reply-to is matt@moderntax.io so her response routes to Matt.
 *
 * Approved by Matt 2026-06-02 (he reviewed the copy before scheduling).
 * Auth: CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import sgMail from '@sendgrid/mail';
import { requireBearer } from '@/lib/auth-util';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TO = 'erin.wilsey@bancofcal.com';
const REQUEST_URL = 'https://portal.moderntax.io/request/14759497-8519-4f68-81a4-7ebd101581ca';

/** Unix seconds for the next 8:00 AM America/New_York. */
function next8amEtUnix(): number {
  const now = new Date();
  const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const offsetMs = now.getTime() - etNow.getTime(); // UTC - ET wall time
  const target = new Date(etNow);
  target.setHours(8, 0, 0, 0);
  if (target.getTime() <= etNow.getTime()) target.setDate(target.getDate() + 1);
  return Math.floor((target.getTime() + offsetMs) / 1000);
}

export async function POST(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  if (!process.env.SENDGRID_API_KEY) {
    return NextResponse.json({ error: 'SENDGRID_API_KEY not configured' }, { status: 500 });
  }
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const sendAt = next8amEtUnix();

  const html = `
<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a2845;line-height:1.55;">
  <p>Hi Erin,</p>
  <p>The Tax Compliance Report you asked about for <strong>ORR Inc</strong> is now available in your portal — this is the civil-penalty + filed/unfiled compliance report (no income transcripts), our equivalent of a Tax Guard report.</p>
  <p style="margin:20px 0;">
    <a href="${REQUEST_URL}" style="display:inline-block;background:#00c48c;color:#fff;padding:12px 26px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">Open the request &rarr;</a>
  </p>
  <p>On the request page, under the <strong>ORR Inc</strong> entity, click <strong>"View Tax Compliance Report"</strong> — or <strong>"Download PDF"</strong> for a copy to share with your team.</p>
  <p><strong>What it shows</strong>, sourced directly from IRS Account Transcripts:</p>
  <ul style="padding-left:20px;">
    <li>A Tax Risk Score (0&ndash;100) with risk band</li>
    <li>Total IRS liability, plus any amounts subject to liens or at risk of levy</li>
    <li>Civil-penalty status by year</li>
    <li>Filed vs. unfiled returns by year</li>
    <li>Installment-agreement status</li>
  </ul>
  <p>For ORR Inc specifically, it came back clean: low risk, returns filed for 2022&ndash;2024 (2025 not yet filed), no civil penalties, and no outstanding liability or liens.</p>
  <p>Going forward you can order this same report on any entity or guarantor without pulling transcripts &mdash; in Manual Entry, just choose <strong>"Filing-Compliance Report"</strong> instead of the full verification.</p>
  <p>Would love your read on how it compares to Tax Guard.</p>
  <p>Best,<br/>Matt</p>
</div>`.trim();

  const text = `Hi Erin,

The Tax Compliance Report you asked about for ORR Inc is now available in your portal — the civil-penalty + filed/unfiled compliance report (no income transcripts), our equivalent of a Tax Guard report.

Open the request: ${REQUEST_URL}
Under the ORR Inc entity, click "View Tax Compliance Report" (or "Download PDF").

What it shows, from IRS Account Transcripts: a Tax Risk Score, total IRS liability (with lien/levy exposure), civil-penalty status by year, filed vs. unfiled returns, and installment-agreement status. For ORR Inc it came back clean: low risk, returns filed 2022-2024 (2025 not yet filed), no civil penalties, no liability or liens.

Going forward you can order this on any entity or guarantor without pulling transcripts — in Manual Entry, choose "Filing-Compliance Report" instead of the full verification.

Would love your read on how it compares to Tax Guard.

Best,
Matt`;

  try {
    await sgMail.send({
      to: TO,
      from: { email: 'no-reply@moderntax.io', name: 'ModernTax' },
      replyTo: 'matt@moderntax.io',
      subject: 'Your Tax Compliance Report for ORR Inc is ready in the portal',
      html,
      text,
      sendAt,
    });
  } catch (err: any) {
    return NextResponse.json({ error: 'SendGrid send failed', detail: err?.response?.body || err?.message || String(err) }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    to: TO,
    scheduled_send_at_unix: sendAt,
    scheduled_send_at_iso: new Date(sendAt * 1000).toISOString(),
    scheduled_send_at_et: new Date(sendAt * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }),
  });
}
