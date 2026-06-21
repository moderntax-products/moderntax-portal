/**
 * GET /api/cron/processor-delay-digest
 *
 * "Orders not delivered within 24h" relay. For every entity still in active
 * IRS work past 24h, pull the latest internal admin<->expert note (the
 * real-time IRS status — e.g. "PPS said the transcript delivery system has
 * been down 3–4 hours") and compile an ADMIN digest with a sanitized,
 * processor-ready blurb for each.
 *
 * Why admin-mediated (not auto-sent to processors):
 *   - Standing rule: nothing is sent on Matt's behalf without him seeing it.
 *   - 2026-05-28 directive: "No expert→processor communication in the system;
 *     admin reviews everything." Expert notes never go straight to clients.
 *   So this cron surfaces WHAT to relay and the draft text; Matt approves and
 *   relays. (A one-click approve-to-send endpoint can layer on later.)
 *
 * Auth: CRON_SECRET bearer. Suggested schedule: daily 13:00 UTC.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { businessHoursElapsed } from '@/lib/expert-sla';
import sgMail from '@sendgrid/mail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Entity is "in active IRS work" — an order the processor is waiting on
// delivery for. Excludes terminal (completed/failed/canceled) and pre-IRS
// (pending / awaiting-signature) states where a >24h age isn't our IRS delay.
const ACTIVE_IRS_STATUSES = ['8821_signed', 'assigned', 'in_progress', 'irs_queue', 'processing'];
const DELAY_THRESHOLD_HOURS = 24;

const esc = (s: string) => (s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;
  if (!process.env.SENDGRID_API_KEY) {
    return NextResponse.json({ error: 'SENDGRID_API_KEY not configured' }, { status: 500 });
  }
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const admin = createAdminClient();
  const now = Date.now();

  // 1. Active, undelivered entities, joined to their request + client + processor.
  const { data: entities, error } = await (admin.from('request_entities') as any)
    .select('id, entity_name, status, updated_at, request_id, requests!inner(id, status, loan_number, created_at, clients(name), profiles!requests_requested_by_fkey(full_name, email))')
    .in('status', ACTIVE_IRS_STATUSES)
    .neq('requests.status', 'cancelled')
    .limit(2000) as { data: any[] | null; error: any };
  if (error) return NextResponse.json({ error: 'Query failed', detail: error.message }, { status: 500 });

  // Filter to orders older than the threshold (by order placement = request.created_at).
  const overdue = (entities || []).filter((e) => {
    const created = e.requests?.created_at ? new Date(e.requests.created_at).getTime() : null;
    if (created === null) return false;
    // Count BUSINESS hours only — weekends + federal US holidays (e.g.
    // Juneteenth) are not our delivery delay and must not trip the flag.
    return businessHoursElapsed(created, now) >= DELAY_THRESHOLD_HOURS;
  });

  if (overdue.length === 0) {
    return NextResponse.json({ success: true, overdue: 0, message: 'No orders past the 24h delivery threshold.' });
  }

  // 2. Latest IRS-STATUS note per overdue entity. Only status-bearing kinds are
  //    relayable. NEVER 'instruction' (internal order directions like "request
  //    ROA + 941 for 2024"), nor 'question'/'answer' (internal Q&A) — relaying
  //    those to the processor leaks internal workflow dressed up as IRS status.
  const ids = overdue.map((e) => e.id);
  const RELAYABLE_NOTE_KINDS = ['status_update', 'note'];
  const { data: notes } = await (admin.from('entity_notes' as any) as any)
    .select('entity_id, author_role, body, kind, created_at')
    .in('entity_id', ids)
    .in('kind', RELAYABLE_NOTE_KINDS)
    .order('created_at', { ascending: false }) as { data: any[] | null };
  const latestNoteByEntity = new Map<string, any>();
  for (const n of notes || []) {
    if (!latestNoteByEntity.has(n.entity_id)) latestNoteByEntity.set(n.entity_id, n);
  }

  // 3. Build per-order rows grouped by client.
  type Row = { entity: string; loan: string; status: string; ageH: number; client: string; processor: string; note: any | null };
  const rows: Row[] = overdue.map((e) => {
    const createdMs = new Date(e.requests.created_at).getTime();
    return {
      entity: e.entity_name,
      loan: e.requests?.loan_number || '—',
      status: e.status,
      ageH: Math.round(businessHoursElapsed(createdMs, now)),
      client: e.requests?.clients?.name || 'Unknown client',
      processor: e.requests?.profiles?.full_name || e.requests?.profiles?.email || 'Unknown',
      note: latestNoteByEntity.get(e.id) || null,
    };
  }).sort((a, b) => b.ageH - a.ageH);

  const withStatus = rows.filter((r) => r.note);
  const noStatus = rows.filter((r) => !r.note);

  // Sanitized processor-ready blurb (no expert identity, just the IRS status).
  const processorBlurb = (r: Row): string => {
    const reason = r.note?.body ? `Latest update from our IRS team: "${r.note.body.trim()}"` :
      'Our IRS team is actively working this order.';
    return `Quick status on ${r.entity}${r.loan !== '—' ? ` (loan ${r.loan})` : ''}: it's still in progress with the IRS — ${reason} We'll deliver the transcripts as soon as the IRS releases them and will keep you posted.`;
  };

  const rowHtml = (r: Row) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee;"><strong>${esc(r.entity)}</strong><br/><span style="color:#6b7280;font-size:12px;">${esc(r.client)} · ${esc(r.processor)}</span></td>
      <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap;">${r.status}<br/><span style="color:#b45309;font-size:12px;">${r.ageH}h business-time</span></td>
      <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px;color:#1f2937;">${r.note ? `<em>${esc(r.note.kind)}:</em> ${esc(r.note.body)}` : '<span style="color:#9ca3af;">no internal note yet</span>'}</td>
    </tr>`;

  const draftsHtml = withStatus.map((r) => `
    <div style="margin:10px 0;padding:10px 12px;background:#f8fafc;border-left:3px solid #295c9e;">
      <div style="font-size:12px;color:#6b7280;margin-bottom:4px;">To ${esc(r.processor)} (${esc(r.client)}) — re: ${esc(r.entity)}</div>
      <div style="font-size:13px;color:#1f2937;white-space:pre-wrap;">${esc(processorBlurb(r))}</div>
    </div>`).join('');

  const html = `
<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:720px;margin:0 auto;color:#1a2845;line-height:1.5;">
  <h2 style="margin:0 0 4px;">⏱ Orders past 24 business-hrs — ${rows.length} undelivered</h2>
  <p style="color:#9ca3af;font-size:11px;margin:0 0 8px;">Business hours only — weekends &amp; federal US holidays excluded.</p>
  <p style="color:#6b7280;margin:0 0 16px;">${withStatus.length} have a live IRS-status note to relay · ${noStatus.length} have no internal note yet (worth pinging the expert).</p>

  <table style="border-collapse:collapse;width:100%;font-size:13px;">
    <thead><tr style="text-align:left;color:#374151;"><th style="padding:8px;">Order</th><th style="padding:8px;">Status</th><th style="padding:8px;">Latest internal note (IRS status)</th></tr></thead>
    <tbody>${rows.map(rowHtml).join('')}</tbody>
  </table>

  ${withStatus.length ? `<h3 style="margin:20px 0 4px;">Draft processor relays (review &amp; send)</h3>
  <p style="color:#6b7280;font-size:12px;margin:0 0 8px;">Sanitized — no expert identity. Forward/approve the ones you want the processor to see.</p>
  ${draftsHtml}` : ''}

  <p style="color:#9ca3af;font-size:12px;margin-top:20px;">Nothing was sent to processors. This digest is for your review per the standing approval rule.</p>
</div>`.trim();

  // Recipients: all admins (fallback to matt@).
  const { data: admins } = await (admin.from('profiles') as any)
    .select('email').eq('role', 'admin') as { data: { email: string }[] | null };
  const to = Array.from(new Set([...(admins || []).map((a) => a.email).filter(Boolean), 'matt@moderntax.io']));

  try {
    await sgMail.send({
      to,
      from: { email: 'no-reply@moderntax.io', name: 'ModernTax Portal' },
      replyTo: 'matt@moderntax.io',
      subject: `⏱ ${rows.length} order${rows.length === 1 ? '' : 's'} past 24h — IRS-status relays ready for review`,
      html,
    });
  } catch (err: any) {
    return NextResponse.json({ error: 'Send failed', detail: err?.response?.body?.errors?.[0]?.message || err?.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    overdue: rows.length,
    with_status_note: withStatus.length,
    no_status_note: noStatus.length,
    sent_to: to,
  });
}
