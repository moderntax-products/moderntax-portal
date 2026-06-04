/**
 * POST /api/admin/send-joel-8821-confirmation
 *
 * One-off transactional email to Joel Abernathy confirming the 8821-download
 * fix (experts now get the admin-prepared copy with their designee, not the
 * processor's e-signed original) and touching the other items from his call.
 * Reply-to matt@moderntax.io. Auth: CRON_SECRET. Approved by Matt 2026-06-03.
 */

import { NextRequest, NextResponse } from 'next/server';
import sgMail from '@sendgrid/mail';
import { requireBearer } from '@/lib/auth-util';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TO = 'joelsteven@earthlink.net';

export async function POST(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;
  if (!process.env.SENDGRID_API_KEY) {
    return NextResponse.json({ error: 'SENDGRID_API_KEY not configured' }, { status: 500 });
  }
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const html = `
<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a2845;line-height:1.55;">
  <p>Hi Joel,</p>
  <p>Following up on your notes — the big one is fixed: the 8821 in your queue that wasn&rsquo;t in your name (or was e-signed) is resolved. Your dashboard now shows the <strong>admin-prepared 8821</strong> for each assignment, with <strong>your designee credentials</strong>, ready for your IRS call. The processor&rsquo;s original is no longer shown to you at all.</p>
  <p>Both of your current assignments &mdash; <strong>The O Factor LLC</strong> and <strong>Dr. Linda Oliver Chiropractic</strong> &mdash; already have the correct 8821 posted. Just <strong>refresh your dashboard and click &ldquo;Download 8821&rdquo;</strong> and you&rsquo;ll get the right form. (If an admin copy isn&rsquo;t up yet on a future assignment, you&rsquo;ll see &ldquo;8821 being prepared by admin&rdquo; instead of a wrong file.)</p>
  <p>A couple of the other things you raised are in too:</p>
  <ul>
    <li><strong>Getting credit for completed work:</strong> there&rsquo;s now a clear warning if you&rsquo;ve uploaded transcripts but haven&rsquo;t hit <em>Submit</em> &mdash; so finished work always counts.</li>
    <li><strong>Time zone / SLA:</strong> you&rsquo;ll be asked to set your time zone in your profile. That makes your SLA windows run on <strong>your local time</strong> (your actual calling windows), not UTC.</li>
  </ul>
  <p>Thanks again for the detailed feedback on the call &mdash; it directly shaped these fixes. Sorry about the missed callback; you should be unblocked now.</p>
  <p>Best,<br/>Matt</p>
</div>`.trim();

  const text = `Hi Joel,

Following up on your notes — the big one is fixed: the 8821 in your queue that wasn't in your name (or was e-signed) is resolved. Your dashboard now shows the ADMIN-prepared 8821 for each assignment, with YOUR designee credentials, ready for your IRS call. The processor's original is no longer shown to you.

Both of your current assignments — The O Factor LLC and Dr. Linda Oliver Chiropractic — already have the correct 8821 posted. Just refresh your dashboard and click "Download 8821" and you'll get the right form. (If an admin copy isn't up yet on a future assignment, you'll see "8821 being prepared by admin" instead of a wrong file.)

A couple of the other things you raised are in too:
- Getting credit for completed work: there's now a clear warning if you've uploaded transcripts but haven't hit Submit — so finished work always counts.
- Time zone / SLA: you'll be asked to set your time zone in your profile, so your SLA windows run on your local time (your actual calling windows), not UTC.

Thanks again for the detailed feedback — it directly shaped these fixes. Sorry about the missed callback; you should be unblocked now.

Best,
Matt`;

  try {
    await sgMail.send({
      to: TO,
      from: { email: 'no-reply@moderntax.io', name: 'ModernTax' },
      replyTo: 'matt@moderntax.io',
      subject: 'Fixed — your assignments now show your 8821 (with your designee)',
      html,
      text,
    });
  } catch (err: any) {
    return NextResponse.json({ error: 'SendGrid send failed', detail: err?.response?.body?.errors?.[0]?.message || err?.message || String(err) }, { status: 500 });
  }

  return NextResponse.json({ success: true, to: TO });
}
