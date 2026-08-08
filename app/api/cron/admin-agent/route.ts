/**
 * Admin support agent cron.
 *
 * The agent works the queue like a human support rep — it talks to the people
 * who owe a task, NOT to the admin. Every 30 min it:
 *
 *   1. INBOUND — answers unanswered inquiries from experts / processors /
 *      direct taxpayers in-thread. The one out-of-scope category (authorization
 *      / legal) it leaves flagged for the admin IN-PORTAL (no email), after a
 *      brief holding reply to the asker.
 *   2. EXPERT SLA NUDGES — for assignments past their (business-hours-aware)
 *      SLA deadline, posts a warm, support-voice check-in to the expert.
 *   3. PROCESSOR TASK NUDGES — for entities whose 8821 has been out for
 *      signature too long, nudges the submitting processor to chase it.
 *
 * All outreach goes through the entity-notes channel (the same path admin notes
 * use to reach experts/processors) plus a direct email to the specific person,
 * so the right recipient is notified. The agent does NOT email the admin
 * digests — its job is to reduce admin involvement, not add to the inbox.
 *
 * ROLLOUT SAFETY: outbound is gated behind ADMIN_AGENT_AUTOSEND=true. Until set,
 * SHADOW mode logs what it WOULD post (cron logs / JSON response) and sends
 * nothing. Matt chose auto-send as the steady state; flip the env var to go live.
 *
 * GET /api/cron/admin-agent — Auth: Vercel cron Bearer secret.
 */

import { NextRequest, NextResponse } from 'next/server';
import sgMail from '@sendgrid/mail';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { decideOnThread, composeOutreach, analyzeTranscriptGap, type ThreadContext } from '@/lib/admin-agent';

export const maxDuration = 60;
export const runtime = 'nodejs';

const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io';
const SUPPORT_AUTHOR = 'ModernTax Support';
const MAX_THREADS_PER_RUN = 25;
const MAX_NUDGES_PER_RUN = 40;
const INBOUND_KINDS = ['question', 'support'];
const INBOUND_ROLES = ['expert', 'processor', 'manager', 'direct_user'];
// Don't re-nudge / re-touch the same entity within this window (avoids 30-min spam).
const NUDGE_COOLDOWN_HOURS = 18;
// A processor's 8821 has been out for signature "too long" past this many days.
const PROCESSOR_8821_STALE_DAYS = 4;
// Transcript-gap detector: only look at recently-completed entities, cap the work.
const TRANSCRIPT_GAP_WINDOW_DAYS = 21;
const MAX_GAP_FLAGS_PER_RUN = 20;
const EMPTY_MARKERS = ['no record of return filed', 'requested data not found'];

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();
  const autoSend = process.env.ADMIN_AGENT_AUTOSEND === 'true';
  const now = Date.now();
  const cooldownMs = NUDGE_COOLDOWN_HOURS * 3600 * 1000;
  const log: string[] = [];

  // Admin author id for posting agent notes (entity_notes only permits admin/expert authors).
  const { data: adminProfile } = await admin
    .from('profiles').select('id').eq('role', 'admin')
    .order('created_at', { ascending: true }).limit(1).maybeSingle() as { data: { id: string } | null };
  if (!adminProfile) {
    return NextResponse.json({ success: false, error: 'no admin profile to author agent notes' });
  }

  // Has the agent already posted a Support note on this entity within the cooldown?
  async function recentlyTouched(entityId: string): Promise<boolean> {
    const { data } = await (admin.from('entity_notes' as any) as any)
      .select('id').eq('entity_id', entityId).eq('author_name', SUPPORT_AUTHOR)
      .gte('created_at', new Date(now - cooldownMs).toISOString()).limit(1).maybeSingle();
    return !!data;
  }

  // ─── 1. Inbound inquiries — answer in-thread; flag auth/legal for admin ───
  const sinceIso = new Date(now - 30 * 24 * 3600 * 1000).toISOString();
  const { data: candidates } = await (admin.from('entity_notes' as any) as any)
    .select('id, entity_id, author_id, author_role, author_name, body, kind, created_at')
    .in('kind', INBOUND_KINDS).in('author_role', INBOUND_ROLES)
    .gte('created_at', sinceIso).order('created_at', { ascending: false }) as { data: any[] | null };

  const latestInboundByEntity = new Map<string, any>();
  for (const n of candidates || []) {
    if (!latestInboundByEntity.has(n.entity_id)) latestInboundByEntity.set(n.entity_id, n);
  }

  let answered = 0;
  let escalated = 0;
  let processed = 0;

  for (const [entityId, inquiry] of latestInboundByEntity) {
    if (processed >= MAX_THREADS_PER_RUN) break;

    const { data: thread } = await (admin.from('entity_notes' as any) as any)
      .select('author_role, author_name, body, kind, created_at')
      .eq('entity_id', entityId).order('created_at', { ascending: true }) as { data: any[] | null };
    const all = thread || [];
    const last = all[all.length - 1];
    if (!last || last.author_role === 'admin') continue;                 // already handled
    if (last.body !== inquiry.body || last.created_at !== inquiry.created_at) continue; // newer activity

    processed++;

    const { data: entity } = await admin.from('request_entities')
      .select('id, entity_name, form_type, years, status, signed_8821_url, transcript_urls, request_id')
      .eq('id', entityId).single() as { data: any };
    if (!entity) continue;
    const { data: req } = await admin.from('requests')
      .select('loan_number, status, client_id').eq('id', entity.request_id).single() as { data: any };
    let clientName: string | null = null;
    if (req?.client_id) {
      const { data: c } = await admin.from('clients').select('name').eq('id', req.client_id).single() as { data: any };
      clientName = c?.name || null;
    }
    const { data: asn } = await admin.from('expert_assignments')
      .select('status, sla_deadline').eq('entity_id', entityId)
      .in('status', ['assigned', 'in_progress']).order('assigned_at', { ascending: false })
      .limit(1).maybeSingle() as { data: any };
    const slaOverdue = !!(asn?.sla_deadline && Date.parse(asn.sla_deadline) < now);

    const ctx: ThreadContext = {
      entityName: entity.entity_name,
      loanNumber: req?.loan_number || null,
      clientName,
      formType: entity.form_type,
      years: entity.years,
      entityStatus: entity.status,
      requestStatus: req?.status || null,
      signed8821OnFile: !!entity.signed_8821_url,
      transcriptsReadyCount: (entity.transcript_urls || []).length,
      sla: asn ? { overdue: slaOverdue, note: asn.sla_deadline ? `deadline ${String(asn.sla_deadline).slice(0, 16)}` : undefined } : null,
      inquiry: { authorRole: inquiry.author_role, authorName: inquiry.author_name, body: inquiry.body, kind: inquiry.kind },
      history: all.slice(0, -1).map((h: any) => ({ authorRole: h.author_role, authorName: h.author_name, body: h.body })),
    };

    const decision = await decideOnThread(ctx);
    const tag = `${entity.entity_name} ← ${inquiry.author_name} (${inquiry.author_role})`;

    if (decision.action === 'reply' && decision.reply) {
      if (autoSend) {
        await postNote(admin, entityId, adminProfile.id, decision.reply, inquiry.kind === 'support' ? 'support' : 'answer');
        await emailRecipient(admin, inquiry.author_id, `Re: ${entity.entity_name}${req?.loan_number ? ` (loan ${req.loan_number})` : ''}`, decision.reply);
        answered++;
        log.push(`ANSWERED ${tag} [${decision.category}/${decision.confidence}]`);
      } else {
        log.push(`WOULD ANSWER ${tag} [${decision.category}] → ${decision.reply.slice(0, 120)}`);
      }
    } else {
      // Out of service area (authorization/legal) → hold for the asker, leave
      // flagged for the admin IN-PORTAL. No admin email.
      if (autoSend) {
        await postNote(
          admin, entityId, adminProfile.id,
          'Thanks for flagging this — it needs a quick check on our side and our team will follow up shortly.',
          inquiry.kind === 'support' ? 'support' : 'note',
        );
      }
      escalated++;
      log.push(`ESCALATE (in-portal) ${tag} — ${decision.escalation_reason || decision.category}`);
    }
  }

  // ─── 2. Expert SLA nudges — reach out to whoever's past their deadline ────
  let expertNudges = 0;
  const { data: overdueAssns } = await admin.from('expert_assignments')
    .select('entity_id, expert_id, sla_deadline, status, assigned_at')
    .in('status', ['assigned', 'in_progress'])
    .lt('sla_deadline', new Date(now).toISOString())
    .order('sla_deadline', { ascending: true }) as { data: any[] | null };

  for (const a of overdueAssns || []) {
    if (expertNudges >= MAX_NUDGES_PER_RUN) break;
    if (await recentlyTouched(a.entity_id)) continue;

    const { data: entity } = await admin.from('request_entities')
      .select('entity_name, form_type, years, request_id').eq('id', a.entity_id).single() as { data: any };
    if (!entity) continue;
    const { data: req } = await admin.from('requests').select('loan_number').eq('id', entity.request_id).single() as { data: any };
    const { data: expert } = await admin.from('profiles').select('full_name, email').eq('id', a.expert_id).single() as { data: any };
    if (!expert?.email) continue;

    const hoursOver = Math.max(0, Math.round((now - Date.parse(a.sla_deadline)) / 3600000));
    const situation = `it's now past our turnaround window (${hoursOver}h over the ${String(a.sla_deadline).slice(0, 10)} SLA)`;
    const ask = 'Are you able to wrap it up today, or is anything blocking you?';
    const msg = await composeOutreach({
      audience: 'expert', recipientName: expert.full_name || '', entityName: entity.entity_name,
      loanNumber: req?.loan_number || null, formType: entity.form_type, years: entity.years, situation, ask,
    });
    const tag = `${entity.entity_name} → ${expert.full_name || expert.email} (${hoursOver}h over)`;
    if (autoSend) {
      await postNote(admin, a.entity_id, adminProfile.id, msg, 'note');
      await emailRecipient(admin, a.expert_id, `Checking in — ${entity.entity_name}${req?.loan_number ? ` (loan ${req.loan_number})` : ''}`, msg);
      expertNudges++;
      log.push(`SLA NUDGE ${tag}`);
    } else {
      log.push(`WOULD SLA-NUDGE ${tag} → ${msg.slice(0, 120)}`);
    }
  }

  // ─── 3. Processor task nudges — 8821 out for signature too long ───────────
  let processorNudges = 0;
  const staleCutoff = new Date(now - PROCESSOR_8821_STALE_DAYS * 24 * 3600 * 1000).toISOString();
  const { data: staleReqs } = await admin.from('requests')
    .select('id, loan_number, requested_by, created_at')
    .lt('created_at', staleCutoff) as { data: any[] | null };
  const reqById = new Map((staleReqs || []).map(r => [r.id, r]));
  if (reqById.size > 0) {
    const { data: awaiting } = await admin.from('request_entities')
      .select('id, entity_name, form_type, years, status, request_id')
      .eq('status', '8821_sent')
      .in('request_id', [...reqById.keys()]) as { data: any[] | null };

    for (const e of awaiting || []) {
      if (processorNudges >= MAX_NUDGES_PER_RUN) break;
      const req = reqById.get(e.request_id);
      if (!req?.requested_by) continue;
      if (await recentlyTouched(e.id)) continue;
      const { data: proc } = await admin.from('profiles').select('full_name, email, role').eq('id', req.requested_by).single() as { data: any };
      if (!proc?.email || !['processor', 'manager'].includes(proc.role)) continue;

      const daysOut = Math.round((now - Date.parse(req.created_at)) / (24 * 3600000));
      const situation = `the signed 8821 hasn't come back yet (out for signature ~${daysOut} days)`;
      const ask = 'Could you give the borrower a nudge to sign it? Once it\'s back we\'ll start the IRS pull right away.';
      const msg = await composeOutreach({
        audience: 'processor', recipientName: proc.full_name || '', entityName: e.entity_name,
        loanNumber: req.loan_number || null, formType: e.form_type, years: e.years, situation, ask,
      });
      const tag = `${e.entity_name} → ${proc.full_name || proc.email} (~${daysOut}d)`;
      if (autoSend) {
        await postNote(admin, e.id, adminProfile.id, msg, 'note');
        await emailRecipient(admin, req.requested_by, `Quick nudge — 8821 for ${e.entity_name}${req.loan_number ? ` (loan ${req.loan_number})` : ''}`, msg);
        processorNudges++;
        log.push(`8821 NUDGE ${tag}`);
      } else {
        log.push(`WOULD 8821-NUDGE ${tag} → ${msg.slice(0, 120)}`);
      }
    }
  }

  // ─── 4. Transcript-gap detector — MFJ-spouse-primary / unfiled recognition ──
  // Recognize a pull that came back incomplete because the return is filed under
  // a DIFFERENT SSN (classically a joint return under the spouse listed first),
  // and post the instruction note so nobody chases a transcript that will never
  // appear under the queried SSN. (Matt 2026-06-25.)
  let gapFlags = 0;
  const gapWindow = new Date(now - TRANSCRIPT_GAP_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const { data: completedEntities } = await admin.from('request_entities')
    .select('id, entity_name, form_type, years, transcript_urls, transcript_html_urls')
    .eq('status', 'completed').gte('updated_at', gapWindow)
    .not('years', 'is', null).order('updated_at', { ascending: false }).limit(120) as { data: any[] | null };

  for (const e of completedEntities || []) {
    if (gapFlags >= MAX_GAP_FLAGS_PER_RUN) break;
    const requested: string[] = (e.years || []).map(String);
    if (requested.length === 0) continue;

    // Dedupe: the gap detector is the only thing that posts a SUPPORT_AUTHOR
    // 'instruction' note, so one already on file means this entity is handled.
    const { data: priorFlag } = await (admin.from('entity_notes' as any) as any)
      .select('id').eq('entity_id', e.id).eq('author_name', SUPPORT_AUTHOR).eq('kind', 'instruction')
      .limit(1).maybeSingle();
    if (priorFlag) continue;

    const { yearsWithData, emptyYears, distinctTins } = await scanTranscriptFiles(admin, e);
    const gapYears = requested.filter(y => !yearsWithData.includes(y));
    if (gapYears.length === 0) continue;
    // Only act with EVIDENCE of why — an empty IRS pull or a second SSN in the
    // household. A bare missing year with neither is likely just not-yet-pulled;
    // leave that to the SLA/stale paths rather than guessing "unfiled".
    if (emptyYears.length === 0 && distinctTins.length < 2) continue;

    const verdict = await analyzeTranscriptGap({
      entityName: e.entity_name, formType: e.form_type,
      requestedYears: requested, yearsWithData, emptyYears, gapYears, distinctTinSuffixes: distinctTins,
    });
    const tag = `${e.entity_name} — gap ${gapYears.join(',')} [${verdict.likely_cause}/${verdict.confidence}]`;
    if (autoSend) {
      await postNote(admin, e.id, adminProfile.id, verdict.note_body, 'instruction');
      gapFlags++;
      log.push(`TRANSCRIPT-GAP FLAG ${tag}`);
    } else {
      log.push(`WOULD FLAG TRANSCRIPT-GAP ${tag} → ${verdict.note_body.slice(0, 120)}`);
    }
  }

  if (log.length) console.log('[admin-agent]\n' + log.join('\n'));

  return NextResponse.json({
    success: true,
    mode: autoSend ? 'autosend' : 'shadow',
    inbound_processed: processed,
    answered,
    escalated_in_portal: escalated,
    expert_sla_nudges: expertNudges,
    processor_8821_nudges: processorNudges,
    transcript_gap_flags: gapFlags,
    actions: log,
    processed_at: new Date(now).toISOString(),
  });
}

/** Direct-insert an agent note onto the entity thread (in-portal record). */
async function postNote(
  admin: ReturnType<typeof createAdminClient>,
  entityId: string,
  authorId: string,
  body: string,
  kind: string,
): Promise<void> {
  await (admin.from('entity_notes' as any) as any).insert({
    entity_id: entityId, author_id: authorId, author_role: 'admin',
    author_name: SUPPORT_AUTHOR, body, kind,
  });
}

/** Email a specific recipient (the asker, the overdue expert, or the processor). */
async function emailRecipient(
  admin: ReturnType<typeof createAdminClient>,
  recipientId: string | null,
  subject: string,
  body: string,
): Promise<void> {
  if (!process.env.SENDGRID_API_KEY || !recipientId) return;
  const { data: p } = await admin.from('profiles').select('email').eq('id', recipientId).single() as { data: { email: string } | null };
  if (!p?.email) return;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a2b3c;">${escapeHtml(body).replace(/\n/g, '<br>')}</div>`;
  await sgMail.send({
    to: p.email,
    from: { email: FROM_EMAIL, name: SUPPORT_AUTHOR },
    subject,
    text: body,
    html,
  }).catch((e) => console.warn('[admin-agent] recipient email failed:', e?.message || e));
}

function escapeHtml(s: string): string {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Inspect an entity's pulled transcript files to learn which years actually
 * came back with a return, which came back empty ("No record"), and how many
 * distinct SSNs the pull touched (a 2nd SSN ⇒ a likely joint-return spouse).
 *
 * PDFs are treated as real returns (the IRS error pages are only ever HTML — a
 * PDF means there was content to render). HTML files are downloaded and read for
 * the year, the masked TIN, and the empty-result markers. Downloads are bounded.
 */
async function scanTranscriptFiles(
  admin: ReturnType<typeof createAdminClient>,
  entity: { transcript_urls?: string[] | null; transcript_html_urls?: string[] | null },
): Promise<{ yearsWithData: string[]; emptyYears: string[]; distinctTins: string[] }> {
  const paths = [...(entity.transcript_urls || []), ...(entity.transcript_html_urls || [])];
  const yearsWithData = new Set<string>();
  const emptyYears = new Set<string>();
  const tins = new Set<string>();
  let htmlReads = 0;

  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue;
    const yearFromName = (p.match(/20\d\d/) || [])[0];
    if (/\.pdf$/i.test(p)) { if (yearFromName) yearsWithData.add(yearFromName); continue; }
    if (htmlReads >= 14) continue; // bound the work per entity
    let text = '';
    try {
      const { data: blob } = await admin.storage.from('uploads').download(p);
      if (blob) { text = (await blob.text()).toLowerCase(); htmlReads++; }
    } catch { /* unreadable file → fall through */ }
    if (!text) { if (yearFromName) yearsWithData.add(yearFromName); continue; }
    const yr = (text.match(/12-31-(20\d\d)/) || [])[1] || yearFromName;
    const tin = (text.match(/xxx-xx-(\d{4})/) || [])[1];
    if (tin) tins.add(tin);
    const empty = EMPTY_MARKERS.some(m => text.includes(m));
    if (yr) { if (empty) emptyYears.add(yr); else yearsWithData.add(yr); }
  }
  // A year that has any real data outranks an empty artifact for the same year.
  for (const y of yearsWithData) emptyYears.delete(y);
  return { yearsWithData: [...yearsWithData], emptyYears: [...emptyYears], distinctTins: [...tins] };
}
