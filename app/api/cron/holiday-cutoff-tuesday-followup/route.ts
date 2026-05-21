/**
 * GET /api/cron/holiday-cutoff-tuesday-followup
 *
 * Tuesday-morning second-touch for the Memorial Day cutoff broadcast.
 * Scheduled in vercel.json to fire every Tuesday at 12:00 UTC (8am ET /
 * 5am PT), but the handler is a one-shot — it bails as a no-op on any
 * date other than 2026-05-26 (the Tuesday after Memorial Day 2026).
 *
 * Audience: managers + processors at real clients (client_id IS NOT NULL)
 * who, along with their entire client team, did NOT submit a request
 * during the Thu-Fri pre-holiday placement window. The Friday-9am-onward
 * crowd that took our first-wave advice doesn't get pinged again.
 *
 * Auth: standard requireBearer(CRON_SECRET). Vercel auto-injects when
 * firing on the cron schedule; manual fires need the env var on hand.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import sgMail from '@sendgrid/mail';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// Hard date guard: only do work on the Tuesday-after-Memorial-Day 2026.
// Keeps this endpoint safe to leave in vercel.json indefinitely.
const TARGET_DATE_UTC = '2026-05-26';

// Pre-holiday placement window (Thursday 7am ET through Friday 11pm ET).
// Anyone whose client submitted ≥1 request in this window is exempt.
const WINDOW_START_UTC = '2026-05-21T11:00:00Z'; // Thu 2026-05-21 7am ET
const WINDOW_END_UTC = '2026-05-23T03:00:00Z';   // Fri 2026-05-22 11pm ET

const APP_URL = 'https://portal.moderntax.io';

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  // Date guard — only fire on the target Tuesday
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (todayUtc !== TARGET_DATE_UTC) {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: `Today (${todayUtc}) is not the target date (${TARGET_DATE_UTC}). This endpoint is a one-shot follow-up to the Memorial Day cutoff broadcast and is a no-op except on that single Tuesday.`,
    });
  }

  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'SENDGRID_API_KEY missing' }, { status: 500 });
  }
  sgMail.setApiKey(apiKey);
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'active-accounts@moderntax.io';

  const supabase = createAdminClient();

  // ─── 1. Original audience: managers + processors at a real client ──────
  const { data: profiles, error: profErr } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, client_id, clients(name)')
    .in('role', ['manager', 'processor'])
    .not('email', 'is', null)
    .not('client_id', 'is', null) as { data: any[] | null; error: any };
  if (profErr) {
    return NextResponse.json({ error: 'Audience query failed', detail: profErr.message }, { status: 500 });
  }

  // Dedupe by lowercased email; exclude any matt@* (but allow matt+*@*)
  const seen = new Set<string>();
  const audience: { email: string; first_name: string; role: string; client: string; client_id: string }[] = [];
  for (const p of (profiles || []) as any[]) {
    const e = (p.email || '').toLowerCase().trim();
    if (!e || seen.has(e)) continue;
    if (/^matt@/i.test(e)) continue;
    seen.add(e);
    audience.push({
      email: p.email,
      first_name: (p.full_name || '').trim().split(/\s+/)[0] || 'there',
      role: p.role,
      client: p.clients?.name || '?',
      client_id: p.client_id,
    });
  }

  // ─── 2. Drop clients whose team submitted during the window ────────────
  // Pull requests created in the window, group by client_id, exempt anyone
  // whose client is in that set.
  const clientIds = Array.from(new Set(audience.map(a => a.client_id)));
  const { data: windowRequests } = await supabase
    .from('requests')
    .select('client_id')
    .gte('created_at', WINDOW_START_UTC)
    .lt('created_at', WINDOW_END_UTC)
    .in('client_id', clientIds) as { data: any[] | null };
  const submittedClientIds = new Set((windowRequests || []).map((r: any) => r.client_id));

  const procrastinators = audience.filter(a => !submittedClientIds.has(a.client_id));

  // ─── 3. Compose + send ────────────────────────────────────────────────
  const subject = '⚠️ Last call: EOM is Friday — get transcripts in today';

  const buildText = (name: string) => `Hi ${name},

I sent a heads-up Thursday about Memorial Day + end-of-month stacking back-to-back.

Looking at our records, your team didn't get an order in Thursday or Friday — and PPS is going to be punishingly busy this morning as everyone who waited tries to catch up at once.

THE MATH (5 business days left to EOM Friday 5/29):
  Today (Tue 5/26) before noon PT  → PPS pulls Tue PM / Wed AM → DELIVERED Wed-Fri (TIGHT but doable) ⚠️
  Today after noon PT               → PPS pulls Wed → DELIVERED Thu-Fri ⚠️⚠️
  Wed 5/27 or later                 → 🚫 likely after EOM

There's still a real window — but only if the order goes in before lunch.

THREE FASTEST PATHS:
  CSV upload:          ${APP_URL}/new/csv
  Signed 8821 PDF:     ${APP_URL}/new/pdf
  Manual entry:        ${APP_URL}/new/manual

ALREADY HAVE AN 8821 FROM ANOTHER VENDOR?
  Convert it (60 seconds):  ${APP_URL}/new/convert

Reply or call me directly if anything urgent.

Matt Parker
matt@moderntax.io · 650-741-1085 · ModernTax, Inc.
`;

  const escape = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

  const buildHtml = (name: string) => {
    const n = escape(name);
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;background:#f9fafb;color:#1f2937;">
<div style="max-width:600px;margin:0 auto;padding:24px;background:#ffffff;">
  <div style="border-bottom:2px solid #dc2626;padding-bottom:12px;margin-bottom:20px;">
    <h1 style="margin:0;color:#0f172a;font-size:22px;">⚠️ Last call: EOM is Friday</h1>
    <p style="margin:6px 0 0;color:#6b7280;font-size:13px;">5 business days left to end-of-month — and PPS is at its worst Tuesday of the year today.</p>
  </div>

  <p>Hi ${n},</p>

  <p>I sent a heads-up Thursday about Memorial Day + end-of-month stacking back-to-back. Looking at our records, your team didn't get an order in Thursday or Friday — and PPS is going to be punishingly busy this morning as everyone who waited tries to catch up at once.</p>

  <h3 style="color:#0f172a;font-size:15px;margin:18px 0 8px;">The math (5 biz days to EOM Fri 5/29)</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead><tr style="background:#f9fafb;border-bottom:1px solid #e5e7eb;">
      <th style="text-align:left;padding:8px;font-weight:600;">Order placed</th>
      <th style="text-align:left;padding:8px;font-weight:600;">PPS pull</th>
      <th style="text-align:left;padding:8px;font-weight:600;">Delivered</th>
    </tr></thead>
    <tbody>
      <tr style="background:#fffbeb;border-bottom:1px solid #f3f4f6;">
        <td style="padding:8px;"><strong>Today before noon PT</strong></td>
        <td style="padding:8px;">Tue PM / Wed AM</td>
        <td style="padding:8px;"><strong>Wed – Fri</strong> ⚠️ tight but doable</td>
      </tr>
      <tr style="background:#fffbeb;border-bottom:1px solid #f3f4f6;">
        <td style="padding:8px;">Today after noon PT</td>
        <td style="padding:8px;">Wed</td>
        <td style="padding:8px;"><strong>Thu – Fri</strong> ⚠️⚠️</td>
      </tr>
      <tr style="background:#fef2f2;">
        <td style="padding:8px;">Wed 5/27 or later</td>
        <td style="padding:8px;">—</td>
        <td style="padding:8px;"><strong>🚫 likely after EOM</strong></td>
      </tr>
    </tbody>
  </table>

  <p style="font-size:13px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:10px;color:#92400e;">
    There's still a real window — but only if the order goes in before lunch today.
  </p>

  <h3 style="color:#0f172a;font-size:15px;margin:18px 0 8px;">Three fastest paths</h3>
  <ul style="padding-left:18px;">
    <li><a href="${APP_URL}/new/csv" style="color:#00C48C;">CSV upload</a> — batch a list of borrowers, we auto-fire 8821s</li>
    <li><a href="${APP_URL}/new/pdf" style="color:#00C48C;">Signed 8821 PDF</a> — you already collected the signature</li>
    <li><a href="${APP_URL}/new/manual" style="color:#00C48C;">Manual entry</a> — one borrower, ~30 seconds</li>
  </ul>

  <p style="background:#eff6ff;border-left:3px solid #3b82f6;padding:10px 14px;font-size:13px;">
    Already have an 8821 from another vendor? <a href="${APP_URL}/new/convert" style="color:#3b82f6;">Convert it (60 seconds)</a> — borrower e-signs the new ModernTax-designated version on their phone.
  </p>

  <p style="margin:24px 0 8px;">Reply or call me directly if anything urgent.</p>

  <p style="margin:24px 0 0;font-size:14px;color:#1f2937;">
    <strong>Matt Parker</strong><br>
    <span style="color:#6b7280;font-size:12px;">matt@moderntax.io · 650-741-1085 · ModernTax, Inc.</span>
  </p>
</div>
</body></html>`;
  };

  let sent = 0;
  const failed: { email: string; error: string }[] = [];
  for (const r of procrastinators) {
    try {
      await sgMail.send({
        to: r.email,
        from: { email: fromEmail, name: 'Matt Parker, ModernTax' },
        subject,
        html: buildHtml(r.first_name),
        text: buildText(r.first_name),
        replyTo: 'matt@moderntax.io',
        categories: ['marketing', 'holiday-cutoff', 'memorial-day-2026-tuesday-followup'],
        customArgs: { campaign: 'memorial-day-cutoff-2026', wave: 'tuesday-followup', recipient_role: r.role, client: r.client },
      } as any);
      sent++;
    } catch (err: any) {
      const msg = err?.response?.body?.errors?.[0]?.message || err?.message || 'unknown';
      failed.push({ email: r.email, error: msg });
    }
    // Pace SendGrid politely
    await new Promise(res => setTimeout(res, 120));
  }

  return NextResponse.json({
    success: true,
    skipped: false,
    today_utc: todayUtc,
    audience_after_dedup_and_demo_filter: audience.length,
    clients_who_already_placed: submittedClientIds.size,
    procrastinator_count: procrastinators.length,
    emails_sent: sent,
    emails_failed: failed.length,
    failures: failed,
  });
}
