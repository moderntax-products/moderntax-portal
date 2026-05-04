/**
 * May Marketing Lender Batch — daily auto-send cron
 *
 * Per Matt 2026-05-04: the script-based daily 25/day cadence didn't fire
 * Monday because it was manual-trigger only. This cron wraps the same
 * logic so the batch goes out automatically Mon-Fri without human action.
 *
 * Reads scripts/data/hubspot-leads-may2026.json (the cached HubSpot lead
 * list) and scripts/data/may2026-sent.json (the persistent sent log) to
 * pick the next 25 unsent leads. Sends via SendGrid. Stamps the sent log.
 *
 * Schedule (vercel.json): 16:00 UTC (9am PT) Mon-Fri.
 *
 * GET /api/cron/may-marketing-batch
 *   Authorization: Bearer CRON_SECRET
 *
 * NOTE: Vercel serverless filesystem is read-only for /scripts/data
 * outside of build time. We persist the sent log to Supabase instead via
 * the marketing_sent_log table (see migration). This makes the cron
 * stateful in prod where the JSON cache approach won't work.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import sgMail from '@sendgrid/mail';
import { promises as fs } from 'fs';
import path from 'path';

if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM_EMAIL = 'hello@moderntax.io';
const FROM_NAME = 'Matt at ModernTax';
const REPLY_TO = 'hello@moderntax.io';
const PORTAL_SIGNUP = 'https://portal.moderntax.io/signup?utm_source=may2026&utm_medium=email&utm_campaign=lender_reactivation';
const SUBSTACK_URL = 'https://moderntax.substack.com';
const DAILY_BATCH = 25;

export const maxDuration = 60;

interface HsLead {
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  createdAt: string;
  lastDemo: string | null;
}

// Domains explicitly excluded from the lender campaign — non-lenders that
// slipped through the initial cache build. Per Matt's review of the first
// 50 sends 2026-05-04: ~44% were mis-targeted (industry orgs, PE/VC firms,
// risk insurance, event planners, accelerators, foreign legal). Hard-block
// these so future cache rebuilds + cron runs skip them.
const RUNTIME_EXCLUDE_DOMAINS = new Set([
  // Industry orgs
  'naggl.org', '43north.org', 'ftcafe.org',
  // Big-co non-banks
  'wpp.com', 'wfp.org', 'monaco.com',
  // Risk / insurance / event services
  'rizerisk.com', 'eventfullyyourz.com',
  // PE / VC / accelerators
  'gener8tor.com', 'battery.com', 'serentcapital.com', 'mpkequitypartners.com',
  // Adjacent — payments/legal/valuation/consulting
  'remitian.com', 'admlegal.rs', 'lrmlenderconsultants.com',
  'ampbusinessvaluations.com', 'sbp-online.com',
]);

// Personal email providers — typically signers (taxpayers/borrowers) who
// got into HubSpot via 8821 flows. Skip unless their company name signals
// a likely lender contact ('bank', 'capital', 'lending', 'cdc', etc.).
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'icloud.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'comcast.net', 'verizon.net', 'me.com', 'msn.com',
]);
const LENDER_COMPANY_KEYWORDS = [
  'bank', 'capital', 'lending', 'lender', 'finance', 'financial',
  'cdc', 'credit union', 'sba', 'fund', 'mortgage', 'loan',
];

function isLenderCompany(company: string | null): boolean {
  if (!company) return false;
  const lower = company.toLowerCase();
  return LENDER_COMPANY_KEYWORDS.some(kw => lower.includes(kw));
}

function shouldExclude(lead: HsLead): { exclude: boolean; reason?: string } {
  const domain = lead.email.split('@')[1]?.toLowerCase() || '';
  if (RUNTIME_EXCLUDE_DOMAINS.has(domain)) {
    return { exclude: true, reason: `domain:${domain}` };
  }
  if (PERSONAL_EMAIL_DOMAINS.has(domain) && !isLenderCompany(lead.company)) {
    return { exclude: true, reason: `personal-email:${domain} (no lender keyword in company)` };
  }
  return { exclude: false };
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization');
  if (!auth || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!process.env.SENDGRID_API_KEY) {
    return NextResponse.json({ error: 'SENDGRID_API_KEY not configured' }, { status: 500 });
  }

  // Load HubSpot lead cache (bundled into the deployment from /scripts/data)
  let leads: HsLead[];
  try {
    const cachePath = path.join(process.cwd(), 'scripts/data/hubspot-leads-may2026.json');
    const raw = await fs.readFile(cachePath, 'utf8');
    const json = JSON.parse(raw);
    leads = (json.addressable || []).map((a: any) => ({
      email: a.email,
      firstName: a.first || null,
      lastName: a.last || null,
      company: a.company || null,
      createdAt: a.created || '',
      lastDemo: a.demo || null,
    }));
  } catch (err) {
    console.error('[may-marketing-batch] cache load failed:', err);
    return NextResponse.json({ error: 'Lead cache not found', details: (err as Error).message }, { status: 500 });
  }

  // Apply runtime filters (non-lender domains + taxpayer-personal-emails).
  // Track per-reason counts so the response payload shows what was kept vs
  // why we skipped — useful when reviewing why a batch is smaller than 25.
  const skipReasons = new Map<string, number>();
  const filteredLeads = leads.filter(l => {
    const r = shouldExclude(l);
    if (r.exclude) {
      skipReasons.set(r.reason!, (skipReasons.get(r.reason!) || 0) + 1);
      return false;
    }
    return true;
  });

  // Load sent log from Supabase (persistent across cron runs)
  const supabase = createAdminClient();
  const { data: sentRows } = await (supabase
    .from('marketing_sent_log' as any) as any)
    .select('email');
  const sentSet = new Set((sentRows || []).map((r: any) => (r.email as string).toLowerCase()));

  const unsent = filteredLeads.filter(l => !sentSet.has(l.email));
  const batch = unsent.slice(0, DAILY_BATCH);
  console.log(`[may-marketing-batch] addressable=${leads.length} after-filter=${filteredLeads.length} sent=${sentSet.size} remaining=${unsent.length} firing=${batch.length}`);
  console.log(`[may-marketing-batch] excluded by runtime filter: ${[...skipReasons.entries()].map(([r, c]) => `${r}=${c}`).join(', ') || 'none'}`);

  if (batch.length === 0) {
    return NextResponse.json({
      success: true, sent: 0, remaining: 0,
      message: 'Campaign complete — all addressable leads emailed',
    });
  }

  let sent = 0;
  let failed = 0;
  const errors: { email: string; error: string }[] = [];
  const sentRecords: { email: string; segment: string; sent_at: string }[] = [];

  for (const lead of batch) {
    const firstName = lead.firstName || lead.email.split('@')[0].split('.')[0];
    const greeting = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
    const ts = lead.lastDemo || lead.createdAt;
    const lastTouchLabel = ts
      ? new Date(ts).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : 'when we last connected';

    const html = renderEmail({ greeting, lastTouchLabel });
    try {
      await sgMail.send({
        to: lead.email,
        from: { email: FROM_EMAIL, name: FROM_NAME },
        replyTo: REPLY_TO,
        subject: `What's new at ModernTax — and a free trial for your team this month`,
        html,
        categories: ['may2026', 'lender_reactivation'],
        customArgs: { segment: 'lenders', source: 'cron' },
      });
      sent++;
      sentRecords.push({ email: lead.email, segment: 'lenders', sent_at: new Date().toISOString() });
      await new Promise(r => setTimeout(r, 50));
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : 'unknown';
      errors.push({ email: lead.email, error: msg });
      console.error(`[may-marketing-batch] send failed for ${lead.email}: ${msg}`);
    }
  }

  // Persist the new sends
  if (sentRecords.length > 0) {
    await (supabase.from('marketing_sent_log' as any) as any).insert(sentRecords);
  }

  return NextResponse.json({
    success: true, sent, failed,
    remaining: unsent.length - sent,
    errors: errors.length > 0 ? errors : undefined,
  });
}

function renderEmail(args: { greeting: string; lastTouchLabel: string }): string {
  const safe = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const bodyHtml = `
<p>Hi ${safe(args.greeting)},</p>
<p>Quick update on what we've shipped at ModernTax since ${safe(args.lastTouchLabel)} — and an open invitation to try the platform free this month.</p>
<h3 style="font-size:16px;color:#0a1929;margin:28px 0 10px 0;">What's new since you last looked</h3>
<ul style="line-height:1.85;padding-left:20px;margin:0 0 18px 0;">
<li><strong>24-48 hour delivery</strong> on all IRS transcript pulls (down from the 10-day Tax Guard standard).</li>
<li><strong>Real-time status tracking</strong> — pulls move from "8821 sent" → "IRS queue" → "delivered" without refreshing.</li>
<li><strong>Automatic 8821 generation + e-signature</strong>. CSV upload, taxpayer signs from email, transcripts arrive.</li>
<li><strong>Compliance flag rollups</strong> — every transcript scanned for unfiled returns, balances due, liens, levies.</li>
<li><strong>IRS Direct Sync</strong> — when IRS systems are live, transcripts sync to your portal automatically.</li>
<li><strong>Account monitoring</strong> — enroll a TIN once, get notified the moment the account changes.</li>
</ul>
<h3 style="font-size:16px;color:#0a1929;margin:28px 0 10px 0;">Industry reads from our blog</h3>
<p style="margin:0 0 14px 0;">Weekly briefs on what's changing at the IRS. Subscribe at <a href="${SUBSTACK_URL}" style="color:#0066cc;">moderntax.substack.com</a>.</p>
<h3 style="font-size:16px;color:#0a1929;margin:28px 0 10px 0;">Try the platform — first 3 verifications free</h3>
<ol style="line-height:1.85;padding-left:20px;margin:0 0 18px 0;">
<li>Sign up at <a href="${PORTAL_SIGNUP}" style="color:#0066cc;font-weight:600;">portal.moderntax.io/signup</a> (60 seconds, no credit card)</li>
<li>The product tour walks you through your first verification end-to-end</li>
<li>Your first 3 verifications are on us — see the platform with your own loan files</li>
</ol>
<p style="text-align:center;margin:28px 0;">
<a href="${PORTAL_SIGNUP}" style="display:inline-block;background:#00C48C;color:#fff;padding:14px 36px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">Start Free Trial &nbsp;&rarr;</a>
</p>
<p style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px 16px;margin:24px 0;border-radius:4px;font-size:14px;color:#78350f;"><strong>Skip the 1:1 demos:</strong> we run a weekly group walkthrough every Thursday 10 AM PT. Same content, you can ask questions alongside other lenders. Reply to this email with "RSVP" and we'll send the calendar invite.</p>
<p style="font-size:14px;color:#444;">Reply with questions — happy to help your team get started.</p>
<p style="margin-top:24px;">Matt Parker<br><span style="color:#666;">Founder, ModernTax</span></p>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="display:none;font-size:1px;color:#f5f5f5;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">What's new at ModernTax + free trial for your team this month.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;padding:24px 0;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);max-width:600px;">
<tr><td style="padding:32px 32px 0 32px;"><div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;margin-bottom:6px;">ModernTax</div></td></tr>
<tr><td style="padding:8px 32px 32px 32px;color:#1a1a1a;line-height:1.65;font-size:15px;">${bodyHtml}</td></tr>
<tr><td style="background:#0a1929;color:#cbd5e0;padding:24px 32px;font-size:12px;line-height:1.6;text-align:center;">
<div style="margin-bottom:6px;"><strong style="color:#fff;">ModernTax</strong> — Rapidly Financial Inc DBA</div>
<div>651 N Broad St, Suite 201, Middletown, DE 19709</div>
<div style="margin-top:10px;"><a href="${SUBSTACK_URL}" style="color:#7dd3fc;text-decoration:none;">Read on Substack</a> &nbsp;·&nbsp; <a href="${SUBSTACK_URL}#unsubscribe" style="color:#7dd3fc;text-decoration:none;">Unsubscribe</a></div>
</td></tr>
</table></td></tr></table></body></html>`;
}
