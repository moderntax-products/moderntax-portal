/**
 * Admin support agent cron.
 *
 * Sweeps the entity-notes inbox for unanswered inquiries (expert questions,
 * processor/manager support, direct-taxpayer support), triages each with the
 * admin agent (lib/admin-agent), and:
 *   - IN-SCOPE  → posts a reply to the thread + emails the asker (CC Matt).
 *   - OUT-OF-SCOPE (authorization/legal, low-confidence, or anything the agent
 *     can't ground) → escalates to the human admin only.
 * Also surfaces SLA breaches (assignments past their deadline) to the admin.
 *
 * ROLLOUT SAFETY: auto-send is gated behind ADMIN_AGENT_AUTOSEND=true. Until
 * that's set, the cron runs in SHADOW mode — it posts/sends nothing to experts
 * or customers and instead emails Matt a digest of what it WOULD send, so the
 * first batch gets one human look (per the standing "see it first" instinct).
 * Matt chose auto-send as the steady state; flipping the env var turns it on.
 *
 * GET /api/cron/admin-agent — Auth: Vercel cron Bearer secret.
 */

import { NextRequest, NextResponse } from 'next/server';
import sgMail from '@sendgrid/mail';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { decideOnThread, type ThreadContext } from '@/lib/admin-agent';

export const maxDuration = 60;
export const runtime = 'nodejs';

const ADMIN_EMAIL = process.env.ADMIN_AGENT_NOTIFY_EMAIL || 'matt@moderntax.io';
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io';
const MAX_THREADS_PER_RUN = 25;
const INBOUND_KINDS = ['question', 'support'];
const INBOUND_ROLES = ['expert', 'processor', 'manager', 'direct_user'];

interface DigestItem {
  entityName: string;
  loanNumber: string | null;
  asker: string;
  inquiry: string;
  outcome: string; // "replied", "would reply (shadow)", "escalated: <reason>"
  reply?: string | null;
}

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();
  const autoSend = process.env.ADMIN_AGENT_AUTOSEND === 'true';
  const now = Date.now();

  // In auto-send mode, posted replies / escalation markers make a thread
  // "handled" so it won't recur — we can safely sweep a long backlog. In shadow
  // mode we post nothing, so we limit to recently-arrived inquiries to avoid
  // re-digesting the same item every run.
  const lookbackMs = autoSend ? 30 * 24 * 3600 * 1000 : 60 * 60 * 1000;
  const sinceIso = new Date(now - lookbackMs).toISOString();

  // An admin author id for posting agent replies / markers.
  const { data: adminProfile } = await admin
    .from('profiles').select('id').eq('role', 'admin')
    .order('created_at', { ascending: true }).limit(1).maybeSingle() as { data: { id: string } | null };

  // ─── 1. Candidate inbound inquiries ──────────────────────────────────────
  const { data: candidates } = await (admin.from('entity_notes' as any) as any)
    .select('id, entity_id, author_id, author_role, author_name, body, kind, created_at')
    .in('kind', INBOUND_KINDS)
    .in('author_role', INBOUND_ROLES)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false }) as { data: any[] | null };

  // Latest inbound inquiry per entity.
  const latestInboundByEntity = new Map<string, any>();
  for (const n of candidates || []) {
    if (!latestInboundByEntity.has(n.entity_id)) latestInboundByEntity.set(n.entity_id, n);
  }

  const digest: DigestItem[] = [];
  const escalations: DigestItem[] = [];
  let replied = 0;
  let processed = 0;

  for (const [entityId, inquiry] of latestInboundByEntity) {
    if (processed >= MAX_THREADS_PER_RUN) break;

    // Full thread — skip if an admin has already responded after this inquiry.
    const { data: thread } = await (admin.from('entity_notes' as any) as any)
      .select('author_role, author_name, body, kind, created_at')
      .eq('entity_id', entityId)
      .order('created_at', { ascending: true }) as { data: any[] | null };
    const all = thread || [];
    const last = all[all.length - 1];
    if (!last || last.author_role === 'admin') continue;        // already handled / no thread
    if (last.body !== inquiry.body || last.created_at !== inquiry.created_at) continue; // newer activity; reassess next run

    processed++;

    // ─── Context for the agent ───
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
    // SLA state for this entity's active assignment.
    const { data: asn } = await admin.from('expert_assignments')
      .select('status, sla_deadline').eq('entity_id', entityId)
      .in('status', ['assigned', 'in_progress']).order('assigned_at', { ascending: false })
      .limit(1).maybeSingle() as { data: any };
    const slaOverdue = !!(asn?.sla_deadline && Date.parse(asn.sla_deadline) < now);

    const history = all.slice(0, -1).map((h: any) => ({
      authorRole: h.author_role, authorName: h.author_name, body: h.body,
    }));
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
      history,
    };

    const decision = await decideOnThread(ctx);
    const base: DigestItem = {
      entityName: entity.entity_name,
      loanNumber: req?.loan_number || null,
      asker: `${inquiry.author_name} (${inquiry.author_role})`,
      inquiry: inquiry.body,
      outcome: '',
    };

    if (decision.action === 'reply' && decision.reply) {
      if (autoSend && adminProfile) {
        // Post the reply to the thread (shows in-portal) ...
        const replyKind = inquiry.kind === 'support' ? 'support' : 'answer';
        await (admin.from('entity_notes' as any) as any).insert({
          entity_id: entityId, author_id: adminProfile.id, author_role: 'admin',
          author_name: 'ModernTax Support', body: decision.reply, kind: replyKind,
        });
        // ... and email the specific asker, CC Matt.
        await emailAsker(admin, inquiry.author_id, entity.entity_name, req?.loan_number || null, decision.reply);
        replied++;
        digest.push({ ...base, outcome: `replied (${decision.category}, ${decision.confidence})`, reply: decision.reply });
      } else {
        digest.push({ ...base, outcome: `WOULD reply (${decision.category}, ${decision.confidence}) — shadow mode`, reply: decision.reply });
      }
    } else {
      // Escalate to the human admin only.
      if (autoSend && adminProfile) {
        await (admin.from('entity_notes' as any) as any).insert({
          entity_id: entityId, author_id: adminProfile.id, author_role: 'admin',
          author_name: 'ModernTax Support',
          body: 'Thanks — I’ve flagged this to our admin team and someone will follow up shortly.',
          kind: inquiry.kind === 'support' ? 'support' : 'note',
        });
      }
      escalations.push({ ...base, outcome: `ESCALATE: ${decision.escalation_reason || decision.category}`, reply: decision.reply });
    }
  }

  // ─── 2. SLA breaches (awareness → admin) ─────────────────────────────────
  const { data: overdueAssns } = await admin.from('expert_assignments')
    .select('entity_id, expert_id, sla_deadline, status')
    .in('status', ['assigned', 'in_progress'])
    .lt('sla_deadline', new Date(now).toISOString()) as { data: any[] | null };
  const slaBreaches = (overdueAssns || []).length;

  // ─── 3. Digest to the human admin ────────────────────────────────────────
  const anything = digest.length || escalations.length || slaBreaches;
  if (anything) {
    await emailDigest(ADMIN_EMAIL, { autoSend, replied, digest, escalations, slaBreaches, overdueAssns: overdueAssns || [] })
      .catch((e) => console.warn('[admin-agent] digest email failed:', e?.message || e));
  }

  return NextResponse.json({
    success: true,
    mode: autoSend ? 'autosend' : 'shadow',
    threads_processed: processed,
    replied,
    escalated: escalations.length,
    drafts_in_shadow: autoSend ? 0 : digest.length,
    sla_breaches: slaBreaches,
    processed_at: new Date(now).toISOString(),
  });
}

async function emailAsker(
  admin: ReturnType<typeof createAdminClient>,
  askerId: string | null,
  entityName: string,
  loanNumber: string | null,
  reply: string,
): Promise<void> {
  if (!process.env.SENDGRID_API_KEY || !askerId) return;
  const { data: p } = await admin.from('profiles').select('email').eq('id', askerId).single() as { data: { email: string } | null };
  if (!p?.email) return;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  await sgMail.send({
    to: p.email,
    from: { email: FROM_EMAIL, name: 'ModernTax Support' },
    cc: ADMIN_EMAIL,
    subject: `Re: ${entityName}${loanNumber ? ` (loan ${loanNumber})` : ''}`,
    text: `${reply}\n\n— ModernTax Support`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a2b3c;">${escapeHtml(reply).replace(/\n/g, '<br>')}<br><br>— ModernTax Support</div>`,
  }).catch((e) => console.warn('[admin-agent] asker email failed:', e?.message || e));
}

async function emailDigest(
  to: string,
  d: { autoSend: boolean; replied: number; digest: DigestItem[]; escalations: DigestItem[]; slaBreaches: number; overdueAssns: any[] },
): Promise<void> {
  if (!process.env.SENDGRID_API_KEY) return;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  const sectionsHtml: string[] = [];

  if (d.escalations.length) {
    sectionsHtml.push(`<h3 style="margin:18px 0 6px;color:#b91c1c;">⚠️ Needs you — outside the agent's service area (${d.escalations.length})</h3>`);
    for (const e of d.escalations) sectionsHtml.push(itemHtml(e));
  }
  if (d.autoSend && d.replied) {
    sectionsHtml.push(`<h3 style="margin:18px 0 6px;color:#0b8457;">✓ Auto-answered (${d.replied})</h3>`);
    for (const e of d.digest) sectionsHtml.push(itemHtml(e));
  }
  if (!d.autoSend && d.digest.length) {
    sectionsHtml.push(`<h3 style="margin:18px 0 6px;color:#1d4ed8;">Drafts the agent WOULD send (shadow mode — nothing sent) (${d.digest.length})</h3>`);
    for (const e of d.digest) sectionsHtml.push(itemHtml(e));
  }
  if (d.slaBreaches) {
    sectionsHtml.push(`<h3 style="margin:18px 0 6px;color:#b45309;">⏱ SLA breaches (${d.slaBreaches})</h3>`);
    sectionsHtml.push(`<p style="font-size:13px;color:#555;">${d.slaBreaches} active assignment(s) are past their SLA deadline. Entity ids: ${d.overdueAssns.slice(0, 20).map((a) => String(a.entity_id).slice(0, 8)).join(', ')}${d.overdueAssns.length > 20 ? '…' : ''}</p>`);
  }

  const header = d.autoSend
    ? 'ModernTax admin agent — run summary'
    : 'ModernTax admin agent — SHADOW run (nothing sent; review drafts below)';

  await sgMail.send({
    to,
    from: { email: FROM_EMAIL, name: 'ModernTax Admin Agent' },
    subject: `${d.autoSend ? '' : '[SHADOW] '}Admin agent: ${d.escalations.length} to review, ${d.autoSend ? d.replied + ' answered' : d.digest.length + ' drafted'}, ${d.slaBreaches} SLA`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a2b3c;">
      <h2 style="margin-bottom:2px;">${header}</h2>
      ${sectionsHtml.join('\n') || '<p>Nothing to report.</p>'}
    </div>`,
  });
}

function itemHtml(e: DigestItem): string {
  return `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin:6px 0;font-size:14px;">
    <div style="font-weight:600;">${escapeHtml(e.entityName)}${e.loanNumber ? ` · loan ${escapeHtml(e.loanNumber)}` : ''}</div>
    <div style="color:#555;font-size:13px;">From ${escapeHtml(e.asker)}</div>
    <div style="margin:4px 0;"><em>${escapeHtml(e.inquiry)}</em></div>
    <div style="color:#111;"><strong>${escapeHtml(e.outcome)}</strong></div>
    ${e.reply ? `<div style="margin-top:4px;color:#0b8457;background:#f0fdf4;border-radius:6px;padding:6px 8px;">${escapeHtml(e.reply).replace(/\n/g, '<br>')}</div>` : ''}
  </div>`;
}

function escapeHtml(s: string): string {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
