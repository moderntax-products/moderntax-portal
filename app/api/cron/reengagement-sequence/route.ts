/**
 * Processor Re-Engagement Sequence cron.
 *
 * Daily (Tue–Thu ~9am PT via vercel.json) it nudges lender processors who have
 * a ModernTax seat but aren't ordering:
 *   - Track A (never activated): 0 orders, signed up 3+ days ago → A1/A2/A3,
 *     then a manager-loop (A4) at day 16 if the account's seats are still idle.
 *   - Track B (lapsed): ordered before, dormant 30+ days → B1/B2/B3, then a
 *     manager-loop (B4) at day 50 if still dormant.
 *
 * Exit is implicit: place any order → no longer matches Track A/B → sequence
 * stops. Suppression: nudges_paused, an open support note < 48h old, weekends/
 * non-Tue–Thu. Manager-loop is batched (one email per lender) and throttled to
 * once per account per 30 days.
 *
 * ROLLOUT: gated behind REENGAGEMENT_AUTOSEND=true. Until set, SHADOW mode logs
 * what it WOULD send (and records shadow rows) but sends nothing.
 *
 * GET /api/cron/reengagement-sequence — Auth: Vercel cron Bearer secret.
 */

import { NextRequest, NextResponse } from 'next/server';
import sgMail from '@sendgrid/mail';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import {
  REP, SUPPORT_EMAIL, stepsForTrack, renderStep, type Track, type MergeContext, type StepDef,
} from '@/lib/reengagement';

export const maxDuration = 60;
export const runtime = 'nodejs';

const DAY_MS = 24 * 3600 * 1000;
const MANAGER_LOOP_THROTTLE_DAYS = 30;

function weekdayInLA(now: number): number {
  // 0=Sun … 6=Sat, evaluated in America/Los_Angeles.
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' }).format(new Date(now));
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

const firstNameOf = (full: string | null, email: string) =>
  (full?.trim().split(/\s+/)[0]) || (email.split('@')[0]) || 'there';

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();
  const autoSend = process.env.REENGAGEMENT_AUTOSEND === 'true';
  const now = Date.now();
  const log: string[] = [];

  // Send window guard: Tue–Thu only (cron schedule handles ~9am PT).
  const wd = weekdayInLA(now);
  if (wd < 2 || wd > 4) {
    return NextResponse.json({ success: true, skipped: 'outside Tue–Thu send window', weekday: wd });
  }

  if (autoSend && process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  // ─── Candidate processors: active seats, not paused ──────────────────────
  const { data: procs } = await admin
    .from('profiles')
    .select('id, email, full_name, client_id, created_at, role, approval_status, nudges_paused')
    .eq('role', 'processor') as { data: any[] | null };
  const candidates = (procs || []).filter(p =>
    p.client_id && p.email && (p.approval_status === 'approved' || p.approval_status == null) && !p.nudges_paused,
  );
  if (candidates.length === 0) {
    return NextResponse.json({ success: true, mode: autoSend ? 'autosend' : 'shadow', candidates: 0 });
  }

  const candidateIds = candidates.map(p => p.id);
  const clientIds = [...new Set(candidates.map(p => p.client_id))];

  // ─── Order history per processor (order_count + last_order) ──────────────
  const orderInfo = new Map<string, { count: number; last: number | null }>();
  {
    const { data: reqs } = await admin
      .from('requests').select('requested_by, created_at')
      .in('requested_by', candidateIds) as { data: any[] | null };
    for (const r of reqs || []) {
      const cur = orderInfo.get(r.requested_by) || { count: 0, last: null };
      cur.count += 1;
      const t = Date.parse(r.created_at || '') || 0;
      if (t && (cur.last == null || t > cur.last)) cur.last = t;
      orderInfo.set(r.requested_by, cur);
    }
  }

  // ─── Already-sent steps per user + per-client manager-loop recency ───────
  const sentByUser = new Map<string, Set<string>>();
  const lastManagerLoopByClient = new Map<string, number>();
  {
    const { data: rows } = await admin
      .from('reengagement_log').select('user_id, client_id, step, sent_at')
      .in('client_id', clientIds) as { data: any[] | null };
    for (const row of rows || []) {
      if (row.user_id) {
        const s = sentByUser.get(row.user_id) || new Set<string>();
        s.add(row.step);
        sentByUser.set(row.user_id, s);
      }
      if (row.step === 'A4' || row.step === 'B4') {
        const t = Date.parse(row.sent_at || '') || 0;
        const prev = lastManagerLoopByClient.get(row.client_id) || 0;
        if (t > prev) lastManagerLoopByClient.set(row.client_id, t);
      }
    }
  }

  // Clients (for lender_name + managers).
  const clientById = new Map<string, { name: string }>();
  {
    const { data: cs } = await admin.from('clients').select('id, name').in('id', clientIds) as { data: any[] | null };
    for (const c of cs || []) clientById.set(c.id, { name: c.name });
  }
  const managersByClient = new Map<string, { email: string; full_name: string | null }[]>();
  {
    const { data: mgrs } = await admin.from('profiles')
      .select('email, full_name, client_id').eq('role', 'manager').in('client_id', clientIds) as { data: any[] | null };
    for (const m of mgrs || []) {
      if (!m.email) continue;
      const arr = managersByClient.get(m.client_id) || [];
      arr.push({ email: m.email, full_name: m.full_name });
      managersByClient.set(m.client_id, arr);
    }
  }

  // Suppression: processor with a support note < 48h old → hold this run.
  const heldUsers = new Set<string>();
  {
    const since = new Date(now - 2 * DAY_MS).toISOString();
    const { data: recent } = await admin.from('entity_notes')
      .select('author_id').eq('kind', 'support').gte('created_at', since)
      .in('author_id', candidateIds) as { data: any[] | null };
    for (const n of recent || []) if (n.author_id) heldUsers.add(n.author_id);
  }

  // ─── Pass 1: per-processor steps + collect manager-loop candidates ───────
  let processorSends = 0;
  const managerCandidates = new Map<string, { track: Track; users: { firstName: string; daysSinceLastOrder: number }[] }>();

  for (const p of candidates) {
    const info = orderInfo.get(p.id) || { count: 0, last: null };
    const daysSinceSignup = Math.floor((now - (Date.parse(p.created_at || '') || now)) / DAY_MS);
    const daysSinceLastOrder = info.last == null ? Infinity : Math.floor((now - info.last) / DAY_MS);

    let track: Track | null = null;
    let metric = 0;
    if (info.count === 0 && daysSinceSignup >= 3) { track = 'A'; metric = daysSinceSignup; }
    else if (info.count >= 1 && daysSinceLastOrder >= 30) { track = 'B'; metric = daysSinceLastOrder; }
    if (!track) continue;

    const firstName = firstNameOf(p.full_name, p.email);
    const lenderName = clientById.get(p.client_id)?.name || 'your team';
    const ctx: MergeContext = {
      firstName, lenderName, daysSinceSignup,
      daysSinceLastOrder: daysSinceLastOrder === Infinity ? 0 : daysSinceLastOrder,
      lastOrderDate: info.last ? new Date(info.last).toISOString().slice(0, 10) : null,
    };

    const steps = stepsForTrack(track);
    const sent = sentByUser.get(p.id) || new Set<string>();

    // Processor-audience steps (A1-A3 / B1-B3): send the next unsent one that's due.
    const procSteps = steps.filter(s => s.audience === 'processor');
    const nextProc = procSteps.find(s => !sent.has(s.step));
    const mgrStep = steps.find(s => s.audience === 'manager')!;

    if (nextProc && metric >= nextProc.day) {
      if (heldUsers.has(p.id)) {
        log.push(`HOLD ${nextProc.step} ${p.email} (support note <48h)`);
      } else {
        await sendStep(admin, autoSend, nextProc, ctx, p.email, p.id, p.client_id, log);
        if (autoSend) processorSends++;
      }
    } else if (metric >= mgrStep.day && !sent.has(mgrStep.step)) {
      // Past the manager-loop day, processor steps exhausted, still idle → batch.
      const slot = managerCandidates.get(p.client_id) || { track, users: [] };
      slot.track = track; // a client trends to one track; last writer is fine for v1
      slot.users.push({ firstName, daysSinceLastOrder: ctx.daysSinceLastOrder });
      managerCandidates.set(p.client_id, slot);
    }
  }

  // ─── Pass 2: manager-loop — one batched email per lender, throttled 30d ──
  let managerSends = 0;
  for (const [clientId, slot] of managerCandidates) {
    const last = lastManagerLoopByClient.get(clientId) || 0;
    if (now - last < MANAGER_LOOP_THROTTLE_DAYS * DAY_MS) {
      log.push(`SKIP manager-loop ${clientId.slice(0, 8)} (sent <30d ago)`);
      continue;
    }
    const managers = managersByClient.get(clientId) || [];
    if (managers.length === 0) { log.push(`SKIP manager-loop ${clientId.slice(0, 8)} (no manager on file)`); continue; }

    const mgrStep = stepsForTrack(slot.track).find(s => s.audience === 'manager')!;
    const lenderName = clientById.get(clientId)?.name || 'your team';
    const names = slot.users.map(u => u.firstName);
    const ctx: MergeContext = {
      firstName: names[0] || 'A teammate',
      lenderName,
      daysSinceSignup: 0,
      daysSinceLastOrder: Math.max(0, ...slot.users.map(u => u.daysSinceLastOrder)),
      lastOrderDate: null,
      managerFirstName: firstNameOf(managers[0].full_name, managers[0].email),
      idleSeatCount: slot.users.length,
      idleUserNames: names.join(', '),
    };
    for (const m of managers) {
      const mctx = { ...ctx, managerFirstName: firstNameOf(m.full_name, m.email) };
      await sendStep(admin, autoSend, mgrStep, mctx, m.email, null, clientId, log, REP.email);
    }
    if (autoSend) managerSends++;
  }

  if (log.length) console.log('[reengagement]\n' + log.join('\n'));

  return NextResponse.json({
    success: true,
    mode: autoSend ? 'autosend' : 'shadow',
    candidates: candidates.length,
    processor_emails: processorSends,
    manager_loop_emails: managerSends,
    actions: log,
    processed_at: new Date(now).toISOString(),
  });
}

/** Send (or shadow-log) one step + record it in reengagement_log. */
async function sendStep(
  admin: ReturnType<typeof createAdminClient>,
  autoSend: boolean,
  def: StepDef,
  ctx: MergeContext,
  toEmail: string,
  userId: string | null,
  clientId: string,
  log: string[],
  cc?: string,
): Promise<void> {
  const { subject, text, html } = renderStep(def, ctx);
  if (autoSend && process.env.SENDGRID_API_KEY) {
    try {
      await sgMail.send({
        to: toEmail,
        from: { email: REP.email, name: `${REP.name}, ModernTax` },
        ...(cc ? { cc } : {}),
        replyTo: REP.email,
        subject, text, html,
      });
      log.push(`SENT ${def.step} → ${toEmail}`);
    } catch (e: any) {
      log.push(`FAIL ${def.step} → ${toEmail}: ${e?.message || e}`);
      return; // don't log a send that didn't happen
    }
  } else {
    log.push(`WOULD SEND ${def.step} → ${toEmail} — "${subject}"`);
  }
  await (admin.from('reengagement_log' as any) as any).insert({
    user_id: userId, client_id: clientId, track: def.track, step: def.step,
    recipient_email: toEmail, shadow: !autoSend,
  }).then((r: any) => { if (r?.error) log.push(`(log insert failed: ${r.error.message})`); });
  void SUPPORT_EMAIL; // reserved for a future reply-to/help line
}
