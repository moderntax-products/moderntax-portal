/**
 * 8821 Processor Follow-Up Cron
 *
 * Find entities where the 8821 has been pending signature for >= 3 days,
 * group by the processor who originated the request, and email each
 * processor a list of their unsigned 8821s. The processor's job is to
 * chase the taxpayer to actually sign — we can't do anything until they
 * do, and pretending the entity is "stale on our side" sends the wrong
 * signal (Matt 2026-05-04: 5 Centerstone entities sitting unsigned for
 * up to 21 days, all flagged "stale" in admin email when the actual
 * blocker is the taxpayer).
 *
 * Cadence: daily, but a per-entity `followup_sent_at` cooldown prevents
 * spamming. We email no more than once every 3 days per entity.
 *
 * Schedule (vercel.json): once per business morning.
 *
 * GET /api/cron/8821-processor-followup
 *   Authorization: Bearer CRON_SECRET
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import sgMail from '@sendgrid/mail';
import { requireBearer } from '@/lib/auth-util';

if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

// Don't bug a processor about the same entity more than once every N days.
const FOLLOWUP_COOLDOWN_DAYS = 3;
// Wait this long after sending the 8821 before the first nudge — gives the
// taxpayer a reasonable window to sign without us being annoying.
const FIRST_FOLLOWUP_AFTER_DAYS = 3;

export const maxDuration = 60;

interface PendingEntity {
  id: string;
  entityName: string;
  signerEmail: string | null;
  signerFirstName: string | null;
  signerLastName: string | null;
  signatureCreatedAt: string;
  daysPending: number;
  loanNumber: string | null;
  followupSentAt: string | null;
}

interface ProcessorBucket {
  email: string;
  fullName: string;
  clientName: string;
  entities: PendingEntity[];
}

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  if (!process.env.SENDGRID_API_KEY) {
    return NextResponse.json({ error: 'SENDGRID_API_KEY not configured' }, { status: 500 });
  }

  const supabase = createAdminClient();
  const now = new Date();
  const firstFollowupCutoff = new Date(now.getTime() - FIRST_FOLLOWUP_AFTER_DAYS * 86400000).toISOString();
  const cooldownCutoff = new Date(now.getTime() - FOLLOWUP_COOLDOWN_DAYS * 86400000).toISOString();

  // Pull all entities awaiting signature ≥ FIRST_FOLLOWUP_AFTER_DAYS days,
  // joined to request + processor + client. Two filters at the SQL layer:
  //   - status='8821_sent'
  //   - signed_8821_url IS NULL  (defensive: skip anything we already have signed)
  //   - signature_created_at <= 3 days ago
  // The cooldown is enforced in JS because Supabase REST doesn't support
  // OR(col IS NULL, col <= X) in one filter cleanly.
  const { data: pending, error } = await supabase
    .from('request_entities')
    .select(
      'id, entity_name, signer_email, signer_first_name, signer_last_name, ' +
      'signature_created_at, signed_8821_url, status, followup_sent_at, ' +
      'requests!inner ( id, loan_number, requested_by, client_id, ' +
      'profiles:requested_by ( email, full_name ), clients ( name, slug ) )',
    )
    .eq('status', '8821_sent')
    .is('signed_8821_url', null)
    .lte('signature_created_at', firstFollowupCutoff)
    .not('signature_created_at', 'is', null) as { data: any[] | null; error: any };

  if (error) {
    console.error('[8821-processor-followup] query failed:', error);
    return NextResponse.json({ error: 'Query failed', details: error.message }, { status: 500 });
  }

  if (!pending || pending.length === 0) {
    return NextResponse.json({
      success: true, processorsEmailed: 0, entitiesFollowedUp: 0,
      message: 'No pending 8821s past first-followup window',
      processedAt: now.toISOString(),
    });
  }

  // Group by processor email; skip entities under cooldown.
  const byProcessor = new Map<string, ProcessorBucket>();
  let skippedDueToCooldown = 0;
  for (const e of pending) {
    if (e.followup_sent_at && e.followup_sent_at > cooldownCutoff) {
      skippedDueToCooldown++;
      continue;
    }
    const proc = e.requests?.profiles;
    const client = e.requests?.clients;
    if (!proc?.email) continue;
    const sigCreated = new Date(e.signature_created_at);
    const daysPending = Math.floor((now.getTime() - sigCreated.getTime()) / 86400000);
    let bucket = byProcessor.get(proc.email);
    if (!bucket) {
      bucket = {
        email: proc.email,
        fullName: proc.full_name || proc.email,
        clientName: client?.name || '',
        entities: [],
      };
      byProcessor.set(proc.email, bucket);
    }
    bucket.entities.push({
      id: e.id,
      entityName: e.entity_name || '(unnamed)',
      signerEmail: e.signer_email,
      signerFirstName: e.signer_first_name,
      signerLastName: e.signer_last_name,
      signatureCreatedAt: e.signature_created_at,
      daysPending,
      loanNumber: e.requests?.loan_number || null,
      followupSentAt: e.followup_sent_at,
    });
  }

  let processorsEmailed = 0;
  let entitiesFollowedUp = 0;
  const errors: { processor: string; error: string }[] = [];
  const sentEntityIds: string[] = [];

  for (const [, bucket] of byProcessor) {
    // Sort by days-pending desc so the most stale ones are at the top
    bucket.entities.sort((a, b) => b.daysPending - a.daysPending);

    const firstName = (bucket.fullName.split(' ')[0] || bucket.fullName).trim();
    const rows = bucket.entities.map(e => {
      const signerName = [e.signerFirstName, e.signerLastName].filter(Boolean).join(' ') || '(taxpayer)';
      const ageColor = e.daysPending >= 7 ? '#dc2626' : e.daysPending >= 5 ? '#d97706' : '#6b7280';
      return `<tr>
<td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;"><strong>${escapeHtml(e.entityName)}</strong></td>
<td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(signerName)}<br><span style="color:#6b7280;font-size:12px;">${escapeHtml(e.signerEmail || '—')}</span></td>
<td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(e.loanNumber || '—')}</td>
<td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:center;color:${ageColor};font-weight:600;">${e.daysPending}d</td>
</tr>`;
    }).join('');

    const subject = `${bucket.entities.length} unsigned 8821${bucket.entities.length === 1 ? '' : 's'} need client follow-up - ${bucket.clientName}`;
    const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;max-width:680px;margin:0 auto;padding:24px;">
<h2 style="margin:0 0 8px 0;color:#0a1929;">${bucket.entities.length} 8821${bucket.entities.length === 1 ? '' : 's'} pending client signature</h2>
<p style="color:#6b7280;margin:0 0 20px 0;">Hi ${escapeHtml(firstName)} - the entities below are blocked on the taxpayer signing the 8821. ModernTax can't pull transcripts until they sign, so the SLA clock for our work is paused.</p>

<div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px 16px;margin:0 0 20px 0;border-radius:4px;font-size:14px;color:#78350f;">
<strong>Action needed:</strong> Please reach out to each taxpayer to remind them to check their inbox for the Dropbox Sign email and complete the 8821. Once signed, ModernTax automatically picks up and starts the IRS pull within 24 business hours.
</div>

<table style="width:100%;border-collapse:collapse;font-size:14px;">
<thead><tr style="background:#f9fafb;">
<th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#6b7280;">Entity</th>
<th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#6b7280;">Signer</th>
<th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#6b7280;">Loan #</th>
<th style="padding:10px 12px;text-align:center;font-size:12px;text-transform:uppercase;color:#6b7280;">Days Pending</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>

<p style="font-size:13px;color:#666;margin-top:20px;">If a taxpayer needs the 8821 resent (e.g., they deleted the original email), reply to this message and we'll fire a fresh request. If a taxpayer has decided not to proceed, reply to mark the entity cancelled so it stops appearing in your queue.</p>

<p style="font-size:12px;color:#9ca3af;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:16px;">You'll receive this reminder no more than once every ${FOLLOWUP_COOLDOWN_DAYS} days per entity. View all your requests at <a href="${APP_URL}/requests" style="color:#0066cc;">portal.moderntax.io/requests</a>.</p>
</body></html>`;

    try {
      await sgMail.send({
        to: bucket.email,
        from: FROM_EMAIL,
        replyTo: 'support@moderntax.io',
        subject,
        html,
      });
      processorsEmailed++;
      entitiesFollowedUp += bucket.entities.length;
      sentEntityIds.push(...bucket.entities.map(e => e.id));
      console.log(`[8821-processor-followup] sent ${bucket.entities.length} reminders to ${bucket.email}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      errors.push({ processor: bucket.email, error: msg });
      console.error(`[8821-processor-followup] failed for ${bucket.email}:`, msg);
    }
  }

  // Stamp followup_sent_at on every entity we just notified about, so the
  // 3-day cooldown filter excludes them on the next run.
  if (sentEntityIds.length > 0) {
    await (supabase.from('request_entities') as any)
      .update({ followup_sent_at: now.toISOString() })
      .in('id', sentEntityIds);
  }

  return NextResponse.json({
    success: true,
    processorsEmailed,
    entitiesFollowedUp,
    skippedDueToCooldown,
    processedAt: now.toISOString(),
    errors: errors.length > 0 ? errors : undefined,
  });
}

function escapeHtml(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
