/**
 * GET /api/cron/resummarize-notify
 *
 * When new transcripts land on an entity that was already summarized/delivered,
 * the batch-upload flags gross_receipts.summary_stale. This cron picks those up,
 * rebuilds the plain-language summary from the full (now-larger) transcript set,
 * and emails the originating processor that new files were added — with the
 * updated headline — so they don't have to re-check the portal blindly.
 *
 * Debounced by design: a burst of files sets one stale flag (files appended);
 * regenerating clears it, so the processor gets ONE "files added" email per
 * batch, not one per file.
 *
 * Auth: Vercel cron Bearer secret (CRON_SECRET). Runs every 15 minutes.
 * Matt 2026-07-30.
 */

import { NextRequest, NextResponse } from 'next/server';
import sgMail from '@sendgrid/mail';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { regenerateProcessorSummary } from '@/lib/processor-summary-generate';

export const maxDuration = 60;
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FROM = process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

function esc(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();
  if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  // Entities that got new files after they were summarized.
  const { data: stale } = await admin
    .from('request_entities')
    .select('id, entity_name, gross_receipts, requests!inner ( id, loan_number, profiles:requested_by ( email, full_name ) )')
    .not('gross_receipts->summary_stale', 'is', null) as { data: any[] | null };

  let regenerated = 0;
  let notified = 0;
  const log: string[] = [];

  for (const e of stale || []) {
    // Grab the added-files list BEFORE regeneration clears the flag.
    const newFiles: string[] = Array.isArray(e.gross_receipts?.summary_stale?.new_files)
      ? e.gross_receipts.summary_stale.new_files : [];

    const res = await regenerateProcessorSummary(admin, e.id);
    if (!res.ok) {
      // Couldn't rebuild (e.g. no parseable HTML) — clear the flag so we don't
      // loop on it forever, but skip the notification.
      const gr = { ...(e.gross_receipts || {}) };
      delete gr.summary_stale;
      await admin.from('request_entities').update({ gross_receipts: gr }).eq('id', e.id);
      log.push(`skip ${e.entity_name}: ${res.error}`);
      continue;
    }
    regenerated++;

    const proc = e.requests?.profiles;
    if (!proc?.email) { log.push(`no processor email for ${e.entity_name}`); continue; }

    const first = (proc.full_name?.split(' ')[0] || proc.full_name || 'there').trim();
    const loan = e.requests?.loan_number || e.entity_name;
    const fileCount = newFiles.length;
    const fileList = newFiles.slice(0, 8).map(f => `<li>${esc(f)}</li>`).join('');
    const summary = res.summary!;

    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;color:#111827;line-height:1.55">
      <p>Hi ${esc(first)},</p>
      <p>${fileCount} new transcript${fileCount === 1 ? '' : 's'} ${fileCount === 1 ? 'was' : 'were'} added to <strong>${esc(e.entity_name)}</strong> on your ${esc(loan)} request${fileCount ? ', and we\'ve refreshed the summary.' : '.'}</p>
      ${fileList ? `<p style="margin:0 0 6px"><strong>Added:</strong></p><ul style="margin:0 0 14px">${fileList}</ul>` : ''}
      <p style="background:#f8fafc;border-left:3px solid #00A57A;padding:12px 14px;border-radius:6px"><strong>Updated summary:</strong> ${esc(summary.headline)}</p>
      <p style="font-size:14px;color:#6b7280">See the full plain-English recap and download the files on the ${esc(loan)} request at
        <a href="${APP_URL}/requests" style="color:#00A57A">portal.moderntax.io</a>.</p>
      <p>— The ModernTax team</p>
    </div>`;
    const text = `Hi ${first},\n\n${fileCount} new transcript(s) were added to ${e.entity_name} on your ${loan} request, and we've refreshed the summary.\n\n`
      + (newFiles.length ? `Added:\n${newFiles.map(f => ` - ${f}`).join('\n')}\n\n` : '')
      + `Updated summary: ${summary.headline}\n\nView it on the ${loan} request at ${APP_URL}/requests\n\n— The ModernTax team`;

    try {
      await sgMail.send({
        to: proc.email, from: FROM, replyTo: 'support@moderntax.io',
        subject: `New transcripts added — ${e.entity_name}`, text, html,
      });
      notified++;
    } catch (err: any) {
      log.push(`send ${proc.email}: ${err?.message || err}`);
    }
  }

  console.log(`[resummarize-notify] regenerated=${regenerated} notified=${notified} candidates=${(stale || []).length}`);
  if (log.length) console.log('[resummarize-notify]', log.join(' | '));
  return NextResponse.json({ ok: true, regenerated, notified, candidates: (stale || []).length, detail: log.slice(0, 30) });
}
