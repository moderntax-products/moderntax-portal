/**
 * Daily 8821 Reminder Cron
 * Sends reminders to signers who haven't signed their 8821 after 24 hours
 * Runs daily at 9 AM ET via Vercel cron
 *
 * Two-path delivery: tries Dropbox Sign's native reminder API first (uses
 * the same email template as the original signature request), and falls
 * back to a SendGrid email if Dropbox Sign returns 402 / payment_required
 * or any other error. The fallback works on the Dropbox Sign free tier
 * since it doesn't call any paid API endpoints.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendReminder } from '@/lib/dropbox-sign';
import sgMail from '@sendgrid/mail';
import { requireBearer } from '@/lib/auth-util';

const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io';

if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

async function sendSendgridFallback(args: {
  signerEmail: string; entityName: string; signatureRequestId: string;
}) {
  if (!process.env.SENDGRID_API_KEY) {
    throw new Error('SendGrid not configured for fallback');
  }
  const subject = `Reminder: please sign Form 8821 for ${args.entityName}`;
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:24px;background:#f5f5f5;">
<div style="background:#fff;border-radius:8px;padding:32px 28px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<h2 style="margin:0 0 16px 0;color:#0a1929;">Friendly reminder: your Form 8821 is still pending</h2>
<p>Hi there,</p>
<p>We're following up on the Form 8821 (Tax Information Authorization) sent for <strong>${args.entityName}</strong>. We haven't received your signature yet, and we need it to pull the IRS transcripts your lender requested.</p>
<p><strong>What to do:</strong></p>
<ol>
<li>Search your inbox for an email from <em>Dropbox Sign</em> with the subject "Form 8821 - Tax Information Authorization for ${args.entityName}".</li>
<li>Open the email and click the "Review &amp; sign" button.</li>
<li>Print your name on the "Print Name" line, sign, and date - takes about 30 seconds.</li>
</ol>
<p>If you can't find the original email, please reply to this message and we'll resend it directly.</p>
<p style="font-size:13px;color:#666;margin-top:24px;">Reference ID: <code>${args.signatureRequestId}</code></p>
<p style="margin-top:24px;">Thanks,<br>ModernTax Team</p>
</div>
</body></html>`;
  await sgMail.send({
    to: args.signerEmail, from: FROM_EMAIL, subject, html,
    replyTo: 'support@moderntax.io',
  });
}

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  // Verify cron secret
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  try {
    const supabase = createAdminClient();

    // Find entities in 8821_sent status with a signature_id, created > 24h ago
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

    const REMINDER_LIMIT = 100;
    const { data: pendingEntities, error } = await supabase
      .from('request_entities')
      .select('id, entity_name, signature_id, signer_email, created_at')
      .eq('status', '8821_sent')
      .not('signature_id', 'is', null)
      .not('signer_email', 'is', null)
      .lt('created_at', twentyFourHoursAgo.toISOString())
      .order('created_at', { ascending: true })
      .limit(REMINDER_LIMIT);

    if (error) {
      console.error('[8821-reminder] Query error:', error);
      return NextResponse.json({ error: 'Query failed' }, { status: 500 });
    }

    if (!pendingEntities || pendingEntities.length === 0) {
      console.log('[8821-reminder] No pending 8821s to remind');
      return NextResponse.json({ reminded: 0 });
    }

    if (pendingEntities.length === REMINDER_LIMIT) {
      console.warn(`[8821-reminder] Hit limit of ${REMINDER_LIMIT} entities — pagination may be needed`);
    }

    let remindedDropbox = 0;
    let remindedFallback = 0;
    let failed = 0;
    const failures: { entityName: string; error: string }[] = [];

    for (const entity of pendingEntities) {
      try {
        await sendReminder(entity.signature_id!, entity.signer_email!);
        remindedDropbox++;
        console.log(`[8821-reminder] Dropbox reminder sent for ${entity.entity_name} → ${entity.signer_email}`);
      } catch (err) {
        // Dropbox Sign API failed (commonly 402 payment_required when on
        // the free tier, or rate-limit errors). Fall back to a SendGrid
        // email so the signer still gets a nudge.
        const dropboxMsg = err instanceof Error ? err.message : 'unknown';
        try {
          await sendSendgridFallback({
            signerEmail: entity.signer_email!,
            entityName: entity.entity_name,
            signatureRequestId: entity.signature_id!,
          });
          remindedFallback++;
          console.log(`[8821-reminder] Fallback (SendGrid) reminder sent for ${entity.entity_name} → ${entity.signer_email} (Dropbox: ${dropboxMsg})`);
        } catch (fallbackErr) {
          failed++;
          const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : 'unknown';
          failures.push({ entityName: entity.entity_name, error: `dropbox: ${dropboxMsg}; fallback: ${fbMsg}` });
          console.error(`[8821-reminder] Both paths failed for ${entity.entity_name}:`, fbMsg);
        }
      }
    }

    const reminded = remindedDropbox + remindedFallback;
    console.log(`[8821-reminder] Done: ${reminded} reminded (${remindedDropbox} via Dropbox, ${remindedFallback} via SendGrid fallback), ${failed} failed`);
    return NextResponse.json({
      reminded, failed, total: pendingEntities.length,
      via: { dropboxSign: remindedDropbox, sendgridFallback: remindedFallback },
      failures: failures.length > 0 ? failures : undefined,
    });
  } catch (error) {
    console.error('[8821-reminder] Cron error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
