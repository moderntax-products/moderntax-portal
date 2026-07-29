/**
 * 8821 Processor Follow-Up Cron
 *
 * Find every entity on an active, submitted request that still has NO signed
 * 8821 — whether the 8821 was already sent for signature (status 8821_sent) or
 * the request was just submitted and the prefill was never sent
 * (status pending/submitted). Group by the processor who originated the
 * request and email each a list, with a per-entity Stage (Not yet sent /
 * Awaiting signature) so they know the next action. We can't pull transcripts
 * until the 8821 is signed, so these orders are stuck until the processor acts.
 *
 * (Broadened 2026-07-29: the old query only saw status=8821_sent, so a
 * submitted request whose entities sat at "pending / 0 signed" — e.g. Cal
 * Statewide's The Great Outdoors — was never nudged and stalled silently.)
 *
 * Cadence: DAILY. The cron runs each business morning; a ~20h per-entity
 * `followup_sent_at` cooldown makes it fire once/day and guards double-sends.
 * First nudge starts the morning after submission (no same-day nag).
 *
 * Schedule (vercel.json): 0 15 * * 1-5 (business mornings).
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

// Daily nudges: a submitted request with an unsigned 8821 is reminded every
// business morning until it's signed. A ~20h cooldown makes it fire once per
// day and guards against a double-send if the cron is re-run.
const FOLLOWUP_COOLDOWN_HOURS = 20;
// Start nudging the next business morning after the request is submitted / the
// 8821 is sent — don't nag same-day.
const FIRST_FOLLOWUP_AFTER_DAYS = 1;

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
  /** 'not_sent' = 8821 prefill exists but hasn't been sent for signature;
   *  'awaiting_signature' = sent, waiting on the taxpayer. */
  stage: 'not_sent' | 'awaiting_signature';
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
  const cooldownCutoff = new Date(now.getTime() - FOLLOWUP_COOLDOWN_HOURS * 3600000).toISOString();

  // Pull every entity that still needs a signed 8821 on an active request —
  // whether the 8821 was already SENT for signature (status 8821_sent) or the
  // request was just submitted and the prefill hasn't been sent yet
  // (status pending/submitted). The old query only saw 8821_sent, so a
  // submitted request whose entities sat at "pending / 0 signed" was never
  // nudged. signed_8821_url IS NULL = no signed copy on file.
  //
  // Age (first-nudge window) + cooldown are enforced in JS: the age anchor is
  // the signature-sent time when present, else the request submission time, so
  // never-sent pending entities still age correctly.
  const { data: pending, error } = await supabase
    .from('request_entities')
    .select(
      'id, entity_name, signer_email, signer_first_name, signer_last_name, ' +
      'signature_created_at, signed_8821_url, status, followup_sent_at, ' +
      'requests!inner ( id, loan_number, requested_by, client_id, status, created_at, ' +
      'profiles:requested_by ( email, full_name ), clients ( name, slug ) )',
    )
    .in('status', ['pending', 'submitted', '8821_sent'])
    .is('signed_8821_url', null) as { data: any[] | null; error: any };

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

  // Group by processor email; skip entities under cooldown / on closed requests.
  const CLOSED = new Set(['completed', 'cancelled', 'failed']);
  const byProcessor = new Map<string, ProcessorBucket>();
  let skippedDueToCooldown = 0;
  for (const e of pending) {
    // An entity can linger 'pending' on a request that was closed elsewhere.
    if (CLOSED.has(e.requests?.status)) continue;
    if (e.followup_sent_at && e.followup_sent_at > cooldownCutoff) {
      skippedDueToCooldown++;
      continue;
    }
    const proc = e.requests?.profiles;
    const client = e.requests?.clients;
    if (!proc?.email) continue;

    // Age anchor: when the 8821 was sent for signature, else when the request
    // was submitted — so a never-sent 'pending' entity ages from submission.
    const anchorIso = e.signature_created_at || e.requests?.created_at;
    if (!anchorIso) continue;
    const daysPending = Math.floor((now.getTime() - new Date(anchorIso).getTime()) / 86400000);
    // Don't nag same-day — wait at least the first-followup window.
    if (daysPending < FIRST_FOLLOWUP_AFTER_DAYS) continue;

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
      signatureCreatedAt: anchorIso,
      daysPending,
      loanNumber: e.requests?.loan_number || null,
      followupSentAt: e.followup_sent_at,
      stage: e.status === '8821_sent' ? 'awaiting_signature' : 'not_sent',
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
    const anyNotSent = bucket.entities.some(e => e.stage === 'not_sent');
    const rows = bucket.entities.map(e => {
      const signerName = [e.signerFirstName, e.signerLastName].filter(Boolean).join(' ') || '(taxpayer)';
      const ageColor = e.daysPending >= 7 ? '#dc2626' : e.daysPending >= 5 ? '#d97706' : '#6b7280';
      const stageLabel = e.stage === 'awaiting_signature'
        ? '<span style="color:#0369a1;">Awaiting signature</span>'
        : '<span style="color:#b45309;">Not yet sent</span>';
      return `<tr>
<td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;"><strong>${escapeHtml(e.entityName)}</strong></td>
<td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(signerName)}<br><span style="color:#6b7280;font-size:12px;">${escapeHtml(e.signerEmail || '—')}</span></td>
<td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:13px;">${stageLabel}</td>
<td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(e.loanNumber || '—')}</td>
<td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:center;color:${ageColor};font-weight:600;">${e.daysPending}d</td>
</tr>`;
    }).join('');

    const subject = `${bucket.entities.length} unsigned 8821${bucket.entities.length === 1 ? '' : 's'} need a signature - ${bucket.clientName}`;
    const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;max-width:680px;margin:0 auto;padding:24px;">
<h2 style="margin:0 0 8px 0;color:#0a1929;">${bucket.entities.length} entit${bucket.entities.length === 1 ? 'y' : 'ies'} still need a signed 8821</h2>
<p style="color:#6b7280;margin:0 0 20px 0;">Hi ${escapeHtml(firstName)} - the entities below are on a submitted request but don't have a signed Form 8821 on file yet. ModernTax can't pull transcripts until the 8821 is signed, so these orders are stuck until then.</p>

<div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px 16px;margin:0 0 20px 0;border-radius:4px;font-size:14px;color:#78350f;">
<strong>Action needed:</strong> ${anyNotSent
  ? 'For anything marked <strong>Not yet sent</strong>, send the pre-filled 8821 to the taxpayer for signature from the request page. For anything <strong>Awaiting signature</strong>, nudge the taxpayer to complete it.'
  : 'Remind each taxpayer to check their inbox and complete the 8821.'} Once it\'s signed, upload the signed copy (or we auto-pick-up Dropbox Sign) and the IRS pull starts within 24 business hours.
</div>

<table style="width:100%;border-collapse:collapse;font-size:14px;">
<thead><tr style="background:#f9fafb;">
<th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#6b7280;">Entity</th>
<th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#6b7280;">Signer</th>
<th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#6b7280;">Stage</th>
<th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#6b7280;">Loan #</th>
<th style="padding:10px 12px;text-align:center;font-size:12px;text-transform:uppercase;color:#6b7280;">Age</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>

<p style="font-size:13px;color:#666;margin-top:20px;">If a taxpayer needs the 8821 resent (e.g., they deleted the original email), reply to this message and we'll fire a fresh request. If a taxpayer has decided not to proceed, reply to mark the entity cancelled so it stops appearing in your queue.</p>

<p style="font-size:12px;color:#9ca3af;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:16px;">You'll get this reminder each business morning until the 8821 is signed. View all your requests at <a href="${APP_URL}/requests" style="color:#0066cc;">portal.moderntax.io/requests</a>.</p>
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
