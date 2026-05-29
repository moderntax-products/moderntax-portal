/**
 * POST /api/admin/email-test-invoice-pdfs
 *
 * Fetches one or more Mercury invoice PDFs (by slug) using the
 * Vercel-side MERCURY_API_KEY, then emails them as attachments via
 * SendGrid. Convenience endpoint so Matt can request "email me the
 * PDFs" without each PDF URL requiring API auth in his browser.
 *
 * Body:
 *   {
 *     to?: string,                              // default matt@moderntax.io
 *     subject?: string,
 *     slugs: Array<{ slug: string; label: string }>,
 *   }
 *
 * Auth: CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import sgMail from '@sendgrid/mail';
import { requireBearer } from '@/lib/auth-util';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  if (!process.env.MERCURY_API_KEY) {
    return NextResponse.json({ error: 'MERCURY_API_KEY not configured' }, { status: 500 });
  }
  if (!process.env.SENDGRID_API_KEY) {
    return NextResponse.json({ error: 'SENDGRID_API_KEY not configured' }, { status: 500 });
  }

  let body: { to?: string; subject?: string; slugs?: Array<{ slug: string; label: string }> };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const to = body.to?.trim() || 'matt@moderntax.io';
  const slugs = Array.isArray(body.slugs) ? body.slugs : [];
  if (slugs.length === 0) {
    return NextResponse.json({ error: 'slugs array required: [{ slug, label }, ...]' }, { status: 400 });
  }
  const subject = body.subject?.trim() || `ModernTax test invoices — ${new Date().toISOString().slice(0, 10)}`;

  // Fetch each PDF from Mercury.
  const mercuryKey = process.env.MERCURY_API_KEY!;
  const attachments: Array<{ content: string; filename: string; type: string; disposition: string }> = [];
  const log: string[] = [];

  for (const { slug, label } of slugs) {
    const url = `https://api.mercury.com/api/v1/ar/invoices/${slug}/pdf`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${mercuryKey}`, Accept: 'application/pdf' },
      });
      if (!res.ok) {
        const txt = await res.text();
        log.push(`✗ ${slug}: HTTP ${res.status} — ${txt.slice(0, 200)}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const filename = `${label.replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`;
      attachments.push({
        content: buf.toString('base64'),
        filename,
        type: 'application/pdf',
        disposition: 'attachment',
      });
      log.push(`✓ ${slug}: ${buf.length} bytes -> ${filename}`);
    } catch (err: any) {
      log.push(`✗ ${slug}: ${err?.message || err}`);
    }
  }

  if (attachments.length === 0) {
    return NextResponse.json({ error: 'No PDFs retrieved', log }, { status: 502 });
  }

  sgMail.setApiKey(process.env.SENDGRID_API_KEY!);
  const html = `
<div style="font-family:-apple-system,sans-serif;max-width:600px;line-height:1.5;color:#1a2845;">
  <p>Hi Matt,</p>
  <p>Attached: <strong>${attachments.length}</strong> test invoice PDF${attachments.length === 1 ? '' : 's'} from Mercury.</p>
  <ul>
    ${slugs.map((s, i) => `<li><code>${s.slug}</code> — ${s.label}${attachments[i] ? '' : ' <em style="color:#dc2626;">(fetch failed)</em>'}</li>`).join('')}
  </ul>
  <p style="font-size:13px;color:#666;">These are TEST invoices routed from a separate "ModernTax TEST" Mercury customer. They will sit in Mercury as Unpaid until cancelled. Do NOT pay or forward.</p>
  <p style="font-size:11px;color:#999;">— Sent via /api/admin/email-test-invoice-pdfs</p>
</div>`;
  await sgMail.send({
    to,
    from: { email: 'no-reply@moderntax.io', name: 'ModernTax Portal' },
    subject,
    html,
    text: `Attached: ${attachments.length} test invoice PDFs from Mercury. ` + slugs.map(s => `${s.slug} (${s.label})`).join('; '),
    attachments,
  });
  log.push(`✓ Email sent to ${to} with ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`);

  return NextResponse.json({ success: true, attachments_count: attachments.length, to, subject, log });
}
