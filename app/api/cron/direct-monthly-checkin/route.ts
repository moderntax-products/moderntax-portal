/**
 * GET /api/cron/direct-monthly-checkin
 *
 * Monthly status update to every PAYING ModernTax Direct customer whose issue
 * isn't resolved yet — they hear from us each month until it's closed out. Copy
 * is personalized to their situation (payroll resolution / ERC recovery /
 * back-year filing). A customer drops off the list when
 * gross_receipts.checkin.resolved is set by the team.
 *
 * ROLLOUT: gated behind DIRECT_CHECKIN_AUTOSEND=true. Until set, SHADOW mode
 * logs (and records on the entity) what it WOULD send but sends nothing — so
 * the first month's batch can be reviewed before any external mail goes out.
 *
 * Auth: Vercel cron Bearer secret (CRON_SECRET). Scheduled monthly (1st, 9am).
 * Matt 2026-07-28.
 */

import { NextRequest, NextResponse } from 'next/server';
import sgMail from '@sendgrid/mail';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { buildCheckin, checkinEmail } from '@/lib/direct-checkin';

export const maxDuration = 60;
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 3600 * 1000;
const RESEND_THROTTLE_DAYS = 20; // don't re-send within the same month on a re-run

const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io';

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();
  const autoSend = process.env.DIRECT_CHECKIN_AUTOSEND === 'true';
  const now = Date.now();
  const monthLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'long', year: 'numeric' })
    .format(new Date(now));
  if (autoSend && process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  // Paying Direct customers only (flag set by the Mercury sync).
  const { data: entities } = await admin
    .from('request_entities')
    .select('id, entity_name, form_type, gross_receipts')
    .filter('gross_receipts->direct_customer->>paying', 'eq', 'true') as { data: any[] | null };

  const log: string[] = [];
  let sent = 0;
  let shadow = 0;
  let skipped = 0;
  // Dedupe by email — a customer with several entities gets ONE monthly note,
  // not one per entity (but we still stamp every entity so the throttle holds).
  const emailedThisRun = new Set<string>();

  for (const entity of entities || []) {
    const r = buildCheckin(entity);
    if (!r) { skipped++; continue; }

    // Throttle: one check-in per ~month even if the cron re-runs.
    const gr = entity.gross_receipts || {};
    const lastSent = gr.checkin?.last_sent_at ? Date.parse(gr.checkin.last_sent_at) : 0;
    if (lastSent && now - lastSent < RESEND_THROTTLE_DAYS * DAY_MS) { skipped++; continue; }

    // Already sent to this customer this run — stamp the entity and move on.
    const emailKey = r.email.trim().toLowerCase();
    if (emailedThisRun.has(emailKey)) {
      const history0 = Array.isArray(gr.checkin?.history) ? gr.checkin.history : [];
      history0.push({ month: monthLabel, mode: 'deduped', subject: '(covered by another entity)', sent_at: new Date(now).toISOString() });
      await admin.from('request_entities').update({
        gross_receipts: { ...gr, checkin: { ...(gr.checkin || {}), last_sent_at: new Date(now).toISOString(), count: (gr.checkin?.count || 0) + 1, history: history0 } },
      }).eq('id', entity.id);
      skipped++;
      continue;
    }
    emailedThisRun.add(emailKey);

    const { subject, html, text } = checkinEmail(r, monthLabel);
    const mode = autoSend ? 'sent' : 'shadow';

    if (autoSend) {
      try {
        await sgMail.send({ to: r.email, from: fromEmail, subject, text, html });
        sent++;
      } catch (e: any) {
        log.push(`send ${r.email}: ${e?.message || e}`);
        continue;
      }
    } else {
      shadow++;
      log.push(`[shadow] → ${r.email}: ${subject}`);
    }

    // Record the check-in on the entity.
    const history = Array.isArray(gr.checkin?.history) ? gr.checkin.history : [];
    history.push({ month: monthLabel, mode, subject, sent_at: new Date(now).toISOString() });
    const next = {
      ...gr,
      checkin: { ...(gr.checkin || {}), last_sent_at: new Date(now).toISOString(), count: (gr.checkin?.count || 0) + 1, history },
    };
    await admin.from('request_entities').update({ gross_receipts: next }).eq('id', entity.id);
  }

  console.log(`[direct-monthly-checkin] mode=${autoSend ? 'autosend' : 'shadow'} sent=${sent} shadow=${shadow} skipped=${skipped}`);
  if (log.length) console.log('[direct-monthly-checkin]', log.join(' | '));

  return NextResponse.json({
    ok: true,
    mode: autoSend ? 'autosend' : 'shadow',
    month: monthLabel,
    candidates: (entities || []).length,
    sent,
    shadow,
    skipped,
    detail: log.slice(0, 50),
  });
}
