/**
 * Weekly 8821 expiration alert cron.
 *
 * IRS Form 8821 authorization is valid for up to 7 years. For lenders on
 * monitoring subscriptions (Moxie's primary use case: life-of-loan
 * monitoring on portfolios), we need to proactively alert when an 8821
 * is approaching expiration so they can collect a fresh signature
 * BEFORE the IRS rejects the next monitoring pull.
 *
 * Driver: Moxie Money's 2026-05-13 ask — "8821 expiration tracking +
 * alerts" was listed as a clearly-asked-for gap (Beth asked directly,
 * Matt didn't commit). This cron closes it without any product
 * commitment — runs weekly, finds expiring 8821s, emails the client
 * manager + processor.
 *
 * Alert windows:
 *   • 90 days out  — informational nudge ("collect fresh 8821 in next quarter")
 *   • 30 days out  — action-required ("8821 expires 30 days, monitoring will fail")
 *   • 7 days out   — urgent ("8821 expires this week")
 *   • expired      — terminal ("monitoring paused, fresh 8821 required to resume")
 *
 * Schedule: weekly Monday at 13:00 UTC = 8 AM ET. (Aligned with start of
 * business week so processors can plan signature collection.)
 *
 * Idempotency: tracks last alert per (entity_id, alert_window) tuple in
 * the entity's gross_receipts JSONB under `_8821_alerts` so we don't
 * spam the same alert weekly.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import sgMail from '@sendgrid/mail';
import { requireBearer } from '@/lib/auth-util';

export const maxDuration = 60;

const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

// IRS Form 8821 validity. Some authorizations specify shorter — but the
// IRS allows up to 7 years by default. We track 7 years from
// signature_created_at to be conservative.
const VALIDITY_YEARS = 7;
const VALIDITY_DAYS = VALIDITY_YEARS * 365;

interface AlertWindow {
  daysOut: number;
  label: string;
  urgency: 'info' | 'warning' | 'critical' | 'expired';
}

// Order matters: the cron uses `.find()` to pick the first matching window
// for an entity's `daysUntilExpiry`. Sort ASCENDING by daysOut so the most
// urgent applicable bucket wins. Previous order (90 → 0) bucketed every
// entity within 90 days into the "info" 90-day window — including ones
// 5 days from expiry — and silenced the critical/warning alerts entirely.
const ALERT_WINDOWS: AlertWindow[] = [
  { daysOut: 0, label: 'expired', urgency: 'expired' },
  { daysOut: 7, label: '7-day', urgency: 'critical' },
  { daysOut: 30, label: '30-day', urgency: 'warning' },
  { daysOut: 90, label: '90-day', urgency: 'info' },
];

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const sb = createAdminClient();
  const now = Date.now();

  // Pull every entity with a signature on file. We need the
  // signature_created_at + still-active monitoring or recent completion
  // (within the last 8 years — beyond that, the 8821 has definitely
  // expired and there's nothing actionable for us to do).
  const lookbackIso = new Date(now - 8 * 365 * 86400_000).toISOString();
  const { data: entities, error } = await sb
    .from('request_entities')
    .select(`
      id, entity_name, signer_email, signer_first_name, signer_last_name,
      signature_created_at, signed_8821_url, status, gross_receipts,
      request_id,
      requests!inner(client_id, loan_number, clients(name, billing_ap_email))
    `)
    .not('signature_created_at', 'is', null)
    .not('signed_8821_url', 'is', null)
    .gte('signature_created_at', lookbackIso)
    .order('signature_created_at', { ascending: true }) as { data: any[] | null; error: any };

  if (error) {
    console.error('[8821-expiration-alert] query failed:', error);
    return NextResponse.json({ error: 'Query failed', details: error.message }, { status: 500 });
  }

  if (!entities || entities.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, message: 'No signed 8821s to check' });
  }

  // Group alerts by recipient (client manager email) so each person gets
  // one digest per cron run rather than N emails.
  interface EntityAlert {
    entity_name: string;
    loan_number: string | null;
    expires_at: string;
    days_until_expiry: number;
    urgency: string;
    alert_key: string;
    entity_id: string;
  }
  const byRecipient = new Map<string, {
    clientName: string;
    entities: EntityAlert[];
  }>();
  let processed = 0;
  let skippedAlreadyAlerted = 0;

  for (const e of (entities || [])) {
    const signedAt = new Date(e.signature_created_at).getTime();
    const expiresAt = signedAt + (VALIDITY_DAYS * 86400_000);
    const daysUntilExpiry = Math.floor((expiresAt - now) / 86400_000);

    // Determine which alert window we're in (if any)
    const window = ALERT_WINDOWS.find((w) => {
      if (w.urgency === 'expired') return daysUntilExpiry <= 0 && daysUntilExpiry >= -7;
      return daysUntilExpiry > 0 && daysUntilExpiry <= w.daysOut;
    });
    if (!window) continue;
    // Don't double-fire — check the gross_receipts._8821_alerts trail
    const alerts = e.gross_receipts?._8821_alerts || {};
    if (alerts[window.label]) {
      skippedAlreadyAlerted++;
      continue;
    }

    const clientMgrEmail = e.requests?.clients?.billing_ap_email
      || e.signer_email
      || null;
    if (!clientMgrEmail) continue;

    const bucket = byRecipient.get(clientMgrEmail) || {
      clientName: e.requests?.clients?.name || 'your client',
      entities: [] as EntityAlert[],
    };
    bucket.entities.push({
      entity_name: e.entity_name,
      loan_number: e.requests?.loan_number || null,
      expires_at: new Date(expiresAt).toISOString().slice(0, 10),
      days_until_expiry: daysUntilExpiry,
      urgency: window.urgency,
      alert_key: window.label,
      entity_id: e.id,
    });
    byRecipient.set(clientMgrEmail, bucket);

    // Stamp the alert in the entity's gross_receipts so we don't re-fire
    const stampedAlerts = { ...(alerts || {}), [window.label]: new Date().toISOString() };
    await sb.from('request_entities')
      .update({ gross_receipts: { ...(e.gross_receipts || {}), _8821_alerts: stampedAlerts } })
      .eq('id', e.id);
    processed++;
  }

  // Send digest per recipient
  let sent = 0;
  for (const [recipient, bucket] of byRecipient.entries()) {
    if (!process.env.SENDGRID_API_KEY) {
      console.warn('[8821-expiration-alert] SENDGRID_API_KEY not set, skipping email send');
      break;
    }
    try {
      const rows = bucket.entities
        .sort((a, b) => a.days_until_expiry - b.days_until_expiry)
        .map((e) => {
          const urgencyColor = e.urgency === 'expired' ? '#991b1b'
            : e.urgency === 'critical' ? '#b91c1c'
            : e.urgency === 'warning' ? '#92400e'
            : '#1e40af';
          const urgencyLabel = e.urgency === 'expired'
            ? `EXPIRED ${Math.abs(e.days_until_expiry)}d ago`
            : `expires in ${e.days_until_expiry}d`;
          return `<tr>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;">${escape(e.entity_name)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace;">${escape(e.loan_number || '—')}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;">${e.expires_at}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;color:${urgencyColor};font-weight:600;">${urgencyLabel}</td>
          </tr>`;
        }).join('');

      const expiredCount = bucket.entities.filter(e => e.urgency === 'expired').length;
      const criticalCount = bucket.entities.filter(e => e.urgency === 'critical').length;
      const subject = expiredCount > 0
        ? `[Action required] ${expiredCount} 8821${expiredCount === 1 ? '' : 's'} expired — fresh signatures needed`
        : criticalCount > 0
          ? `[Action this week] ${criticalCount} 8821${criticalCount === 1 ? '' : 's'} expire within 7 days`
          : `8821 expiration upcoming — ${bucket.entities.length} entit${bucket.entities.length === 1 ? 'y' : 'ies'}`;

      const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;color:#1a1a1a;line-height:1.55;max-width:680px;margin:0 auto;padding:24px;">
<p>Hi there,</p>

<p>${bucket.entities.length} of your monitored entit${bucket.entities.length === 1 ? 'y' : 'ies'} at <strong>${escape(bucket.clientName)}</strong> ${bucket.entities.length === 1 ? 'has' : 'have'} a Form 8821 approaching expiration. The IRS rejects authorization requests on expired 8821s, so monitoring pulls will fail until you collect a fresh signature.</p>

<table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #eee;border-radius:6px;overflow:hidden;margin:20px 0;">
  <thead>
    <tr style="background:#f9f9f9;">
      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #00C48C;">Entity</th>
      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #00C48C;">Loan #</th>
      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #00C48C;">8821 expires</th>
      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #00C48C;">Window</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>

<p><strong>What to do next:</strong></p>
<ol>
  <li>For each entity, click into <a href="${APP_URL}/admin" style="color:#00C48C;">your portal dashboard</a> → request detail page → &ldquo;Request fresh 8821&rdquo; button.</li>
  <li>The system regenerates the 8821 + sends to the original signer via the same signing flow (Dropbox Sign if API available, manual-PDF email otherwise).</li>
  <li>Once signed, the new 8821 replaces the old one and monitoring resumes automatically.</li>
</ol>

<p style="font-size:13px;color:#666;margin-top:24px;">Don&apos;t want these reminders? Reply to this email and we&apos;ll switch them off for your account.</p>

<p style="margin-top:24px;">Best,<br>ModernTax</p>
</body></html>`;

      await sgMail.send({
        to: recipient,
        from: { email: FROM_EMAIL, name: 'ModernTax Notifications' },
        subject,
        html,
        replyTo: 'support@moderntax.io',
      });
      sent++;
      console.log(`[8821-expiration-alert] ✓ digest sent to ${recipient} (${bucket.entities.length} entities)`);
    } catch (err: any) {
      console.error(`[8821-expiration-alert] ✗ send failed for ${recipient}:`, err.message);
    }
  }

  return NextResponse.json({
    ok: true,
    entities_checked: entities.length,
    alerts_triggered: processed,
    recipients_emailed: sent,
    skipped_already_alerted: skippedAlreadyAlerted,
    breakdown_by_recipient: Array.from(byRecipient.entries()).map(([email, bucket]) => ({
      recipient: email,
      client: bucket.clientName,
      entity_count: bucket.entities.length,
      urgency_breakdown: bucket.entities.reduce((acc, e) => {
        acc[e.urgency] = (acc[e.urgency] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    })),
  });
}

function escape(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
