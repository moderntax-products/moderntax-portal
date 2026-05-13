/**
 * 8821 Auto-Send Cron — backfills any entity that's been sitting in
 * status='pending' WITH a signer_email but WITHOUT a signature_id yet.
 *
 * Why this exists: the CSV upload flow already calls sendSignatureRequest()
 * inline (app/api/upload/csv/route.ts:306-353), but that call has a known
 * silent-failure pathway — Dropbox Sign API errors, timeouts, or
 * intermittent service issues can leave the entity stuck at status=
 * 'pending' without flipping to '8821_sent'. There's also a class of
 * historical entities that pre-date the auto-send line.
 *
 * As of 2026-05-13, we had 7 entities stuck in pending with signer_emails
 * populated, ranging from 5–7 days old. Centerstone processor (Robin Kim,
 * Andrew Yu, Justin Kim, Timothy Suk) submissions that never produced
 * a signature request.
 *
 * Behavior:
 *   - Daily cadence, runs after the morning intake batch settles
 *   - For each entity where status='pending' AND signer_email IS NOT NULL
 *     AND signature_id IS NULL AND request.status='submitted':
 *       → call sendSignatureRequest()
 *       → flip status='8821_sent' + persist signature_id
 *       → email matt@moderntax.io a summary
 *   - Idempotent — never re-sends; once signature_id is set, the entity
 *     is skipped by the IS NULL filter
 *   - Max 50 entities per run to keep within the 60-second function limit
 *
 * Auth: CRON_SECRET bearer token (same pattern as all other crons)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendSignatureRequest } from '@/lib/dropbox-sign';
import { send8821ManualSignatureEmail } from '@/lib/sendgrid';
import { generate8821PDF, DESIGNEES } from '@/lib/8821-pdf';
import sgMail from '@sendgrid/mail';
import { requireBearer } from '@/lib/auth-util';

const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io';
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

export const maxDuration = 60;

interface AutoSendResult {
  entity_id: string;
  entity_name: string;
  signer_email: string | null;
  loan_number: string | null;
  outcome: 'sent' | 'failed' | 'skipped';
  signature_id?: string;
  error?: string;
}

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const sb = createAdminClient();
  const MAX_PER_RUN = 50;

  // Find pending entities that look ready to send: signer_email present,
  // no signature_id yet, parent request still in submitted state.
  const { data: candidates, error } = await sb
    .from('request_entities')
    .select(`
      id, entity_name, form_type, tid, tid_kind,
      signer_email, signer_first_name, signer_last_name,
      address, city, state, zip_code, created_at,
      requests!inner(id, loan_number, status, requested_by, client_id)
    `)
    .eq('status', 'pending')
    .not('signer_email', 'is', null)
    .is('signature_id', null)
    // Any non-terminal parent — siblings may have advanced the parent
    // request to 8821_sent already (e.g. MaxMart 18038 → 922 Kilburn
    // fired, Ashvin K Patel still pending under the same parent).
    .not('requests.status', 'in', '("cancelled","completed","failed")')
    .order('created_at', { ascending: true })
    .limit(MAX_PER_RUN) as { data: any[] | null; error: any };

  if (error) {
    console.error('[8821-auto-send-pending] query failed:', error);
    return NextResponse.json({ error: 'Query failed', details: error.message }, { status: 500 });
  }

  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, message: 'No pending entities ready to send' });
  }

  console.log(`[8821-auto-send-pending] found ${candidates.length} pending entities ready to send`);

  const results: AutoSendResult[] = [];
  for (const entity of candidates) {
    try {
      // Defensive — sendSignatureRequest needs signer_email; we already
      // filtered, but checking again so a future schema change can't
      // turn this into a runtime panic.
      if (!entity.signer_email) {
        results.push({
          entity_id: entity.id,
          entity_name: entity.entity_name,
          signer_email: null,
          loan_number: entity.requests?.loan_number || null,
          outcome: 'skipped',
          error: 'no signer_email after filter (data race?)',
        });
        continue;
      }

      const sig = await sendSignatureRequest(
        {
          id: entity.id,
          entity_name: entity.entity_name,
          form_type: entity.form_type,
          tid: entity.tid,
          tid_kind: entity.tid_kind,
          signer_first_name: entity.signer_first_name,
          signer_last_name: entity.signer_last_name,
          address: entity.address,
          city: entity.city,
          state: entity.state,
          zip_code: entity.zip_code,
        },
        entity.signer_email,
      );

      // Persist + flip status
      const { error: updErr } = await sb
        .from('request_entities')
        .update({
          status: '8821_sent',
          signature_id: sig.signatureRequestId,
          signature_created_at: new Date().toISOString(),
        })
        .eq('id', entity.id);

      if (updErr) {
        results.push({
          entity_id: entity.id,
          entity_name: entity.entity_name,
          signer_email: entity.signer_email,
          loan_number: entity.requests?.loan_number || null,
          outcome: 'failed',
          error: `Dropbox Sign succeeded but DB update failed: ${updErr.message}`,
          signature_id: sig.signatureRequestId,
        });
        continue;
      }

      // Bump parent request to 8821_sent if it isn't already
      await sb
        .from('requests')
        .update({ status: '8821_sent' })
        .eq('id', entity.requests.id)
        .eq('status', 'submitted');  // only bump if still submitted

      results.push({
        entity_id: entity.id,
        entity_name: entity.entity_name,
        signer_email: entity.signer_email,
        loan_number: entity.requests?.loan_number || null,
        outcome: 'sent',
        signature_id: sig.signatureRequestId,
      });
      console.log(`[8821-auto-send-pending] ✓ sent for ${entity.entity_name} (${entity.signer_email})`);
    } catch (err: any) {
      // 402 payment_required — Dropbox Sign free tier blocking production
      // signatures. Fall back to emailing the PDF directly via SendGrid
      // and letting the signer print/sign/return manually. Keeps the
      // pipeline moving until the paid Dropbox Sign plan is funded.
      const isPaymentRequired = err.statusCode === 402 || /payment_required/i.test(JSON.stringify(err.body || ''));
      if (isPaymentRequired) {
        try {
          const formType = (entity.form_type || '1040') as '1040' | '1065' | '1120' | '1120S';
          const designee = Object.values(DESIGNEES)[0];
          const address = [entity.address, entity.city, entity.state, entity.zip_code].filter(Boolean).join(', ');
          const pdfBytes = await generate8821PDF({
            taxpayer: { name: entity.entity_name || '', tin: entity.tid || '', address },
            designee,
            formType,
          });
          const signerName = [entity.signer_first_name, entity.signer_last_name].filter(Boolean).join(' ') || entity.entity_name;
          await send8821ManualSignatureEmail({
            signerEmail: entity.signer_email,
            signerName,
            entityName: entity.entity_name,
            formType: entity.form_type || '',
            pdfBytes,
            entityId: entity.id,
          });
          await sb.from('request_entities').update({
            status: '8821_sent',
            signature_id: `MANUAL-${entity.id.slice(0, 8)}`,
            signature_created_at: new Date().toISOString(),
          }).eq('id', entity.id);
          await sb.from('requests').update({ status: '8821_sent' })
            .eq('id', entity.requests.id)
            .in('status', ['submitted', 'pending']);
          results.push({
            entity_id: entity.id,
            entity_name: entity.entity_name,
            signer_email: entity.signer_email,
            loan_number: entity.requests?.loan_number || null,
            outcome: 'sent',
            signature_id: `MANUAL-${entity.id.slice(0, 8)}`,
          });
          console.log(`[8821-auto-send-pending] ✓ MANUAL email sent for ${entity.entity_name} (${entity.signer_email})`);
          continue;
        } catch (fbErr: any) {
          console.error(`[8821-auto-send-pending] ✗ manual fallback failed for ${entity.entity_name}:`, fbErr.message);
          results.push({
            entity_id: entity.id,
            entity_name: entity.entity_name,
            signer_email: entity.signer_email,
            loan_number: entity.requests?.loan_number || null,
            outcome: 'failed',
            error: `Dropbox Sign 402 → manual fallback also failed: ${fbErr.message?.slice(0, 300)}`,
          });
          continue;
        }
      }
      console.error(`[8821-auto-send-pending] ✗ failed for ${entity.entity_name}:`, err.message);
      results.push({
        entity_id: entity.id,
        entity_name: entity.entity_name,
        signer_email: entity.signer_email,
        loan_number: entity.requests?.loan_number || null,
        outcome: 'failed',
        error: err.message?.slice(0, 500) || 'unknown',
      });
    }
  }

  // Summary email to Matt
  const sent = results.filter(r => r.outcome === 'sent');
  const failed = results.filter(r => r.outcome === 'failed');
  if (process.env.SENDGRID_API_KEY && results.length > 0) {
    try {
      const rows = results.map(r => `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${r.entity_name}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${r.loan_number || '—'}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${r.signer_email || '—'}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;color:${r.outcome === 'sent' ? '#15803d' : r.outcome === 'failed' ? '#b91c1c' : '#6b7280'};">${r.outcome.toUpperCase()}${r.error ? ' — ' + r.error.slice(0, 80) : ''}</td>
      </tr>`).join('');
      await sgMail.send({
        to: 'matt@moderntax.io',
        from: { email: FROM_EMAIL, name: 'ModernTax Cron' },
        subject: `[8821 Auto-Send] ${sent.length} sent, ${failed.length} failed`,
        html: `<p>Auto-send sweep for pending entities with signer emails. ${sent.length} 8821s sent, ${failed.length} failed.</p>
<table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #eee;">
  <thead><tr style="background:#f9f9f9;"><th style="padding:6px 10px;text-align:left;">Entity</th><th style="padding:6px 10px;text-align:left;">Loan</th><th style="padding:6px 10px;text-align:left;">Signer</th><th style="padding:6px 10px;text-align:left;">Outcome</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`,
        replyTo: 'support@moderntax.io',
      });
    } catch (emailErr: any) {
      console.error('[8821-auto-send-pending] summary email failed:', emailErr.message);
    }
  }

  return NextResponse.json({
    ok: true,
    processed: results.length,
    sent: sent.length,
    failed: failed.length,
    results,
  });
}
