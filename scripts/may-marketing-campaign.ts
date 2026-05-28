/**
 * May 2026 Marketing Campaign — wire-up
 *
 * Two segments:
 *   A) Lender leads from HubSpot (2025-01-01+, filtered to addressable
 *      prospects) — pushes feature recap + Substack briefs + free 3-TIN
 *      trial signup. CTA: portal.moderntax.io/signup. Weekly webinar
 *      teased; recipients reply to RSVP (no public URL yet).
 *   B) Compliance prospects (5 pilot today) — taxpayers whose 8821-pulled
 *      transcripts triggered CRITICAL flags. CTA: HubSpot meeting link.
 *
 * Key UX choices per Matt 2026-05-01:
 *   - Sender: hello@moderntax.io (NOT matt@) so replies don't flood his
 *     personal inbox. Verified domain on SendGrid.
 *   - No demo-booking CTA in Segment A — the new motion is self-serve
 *     trial + weekly webinar, not 1:1 demos.
 *   - No fabricated Substack article URLs — root link only.
 *
 * Defaults to --dry-run (preview without sending). Pass --send to fire.
 *
 * Run:
 *   npx tsx scripts/may-marketing-campaign.ts <segment> [--send] [--limit N]
 *     segments: lenders | compliance | all
 *
 * IMPORTANT: pass SENDGRID_API_KEY + SENDGRID_FROM_EMAIL on the shell
 * env (not via dotenv) because lib/sendgrid module-level init may have
 * already captured undefined values from cold tsx loads.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import sgMail from '@sendgrid/mail';
import { createClient } from '@supabase/supabase-js';

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

const FROM_EMAIL = 'hello@moderntax.io';
const FROM_NAME = 'Matt at ModernTax';
// Reply-to switched May 7 from hello@ to matt@ — week-1 results showed strong
// engagement (54% open, 32% click) but 0 inbound replies. Goal: route engaged
// readers to the founder's inbox directly so the conversation actually happens.
const REPLY_TO = 'matt@moderntax.io';
const PORTAL_SIGNUP = 'https://portal.moderntax.io/signup?utm_source=may2026&utm_medium=email&utm_campaign=lender_reactivation';
const SUBSTACK_URL = 'https://moderntax.substack.com';
const HUBSPOT_BOOKING = 'https://meetings.hubspot.com/matt-moderntax/moderntax-intro?uuid=d9ba5ab4-c3c0-4cf5-ac96-bffcf71e2d26';

const target = process.argv[2] || '';
const send = process.argv.includes('--send');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1] || '0', 10) : 0;
// --test-to=email@addr: route ALL sends to that address instead of real
// recipients (and limit to 1 per segment) so Matt can preview the rendered
// HTML before firing for real. Subject gets a [TEST] prefix.
const testToArg = process.argv.find(a => a.startsWith('--test-to='));
const testTo = testToArg ? testToArg.split('=')[1] : null;

if (!['lenders', 'compliance', 'borrowers', 'all'].includes(target)) {
  console.error('Usage: npx tsx scripts/may-marketing-campaign.ts <lenders|compliance|borrowers|all> [--send] [--limit N]');
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ---------------------------------------------------------------------------
// Email shell — branded but lighter than the catchup template (this is
// outbound marketing, not transactional). Includes mandatory unsubscribe link.
// ---------------------------------------------------------------------------

function marketingShell(args: {
  preheader: string;
  bodyHtml: string;
  unsubscribeUrl?: string;
}): string {
  const unsub = args.unsubscribeUrl || `${SUBSTACK_URL}#unsubscribe`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="display:none;font-size:1px;color:#f5f5f5;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${args.preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);max-width:600px;">
<tr><td style="padding:32px 32px 0 32px;">
<div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;margin-bottom:6px;">ModernTax</div>
</td></tr>
<tr><td style="padding:8px 32px 32px 32px;color:#1a1a1a;line-height:1.65;font-size:15px;">
${args.bodyHtml}
</td></tr>
<tr><td style="background:#0a1929;color:#cbd5e0;padding:24px 32px;font-size:12px;line-height:1.6;text-align:center;">
<div style="margin-bottom:6px;"><strong style="color:#fff;">ModernTax</strong> — Rapidly Financial Inc DBA</div>
<div>651 N Broad St, Suite 201, Middletown, DE 19709</div>
<div style="margin-top:10px;"><a href="${SUBSTACK_URL}" style="color:#7dd3fc;text-decoration:none;">Read on Substack</a> &nbsp;·&nbsp; <a href="${unsub}" style="color:#7dd3fc;text-decoration:none;">Unsubscribe</a></div>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Segment A — Lender leads
// ---------------------------------------------------------------------------

interface HsLead {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  createdAt: string;
  lastDemo: string | null;
}

async function fetchHubspotLeads(): Promise<HsLead[]> {
  // Reads from a pre-pulled JSON cache (scripts/data/hubspot-leads-may2026.json).
  // The HubSpot MCP returns 200-record pages of 60KB+ JSON each — too large to
  // fit in a single agent context window. The cache is built by paging the MCP
  // outside this script and saving the combined results. Refresh by re-running
  // the puller (see README). For programmatic refresh, set
  // HUBSPOT_PRIVATE_APP_TOKEN and switch this to direct REST calls.
  const path = await import('path');
  const fs = await import('fs/promises');
  const cachePath = path.join(process.cwd(), 'scripts/data/hubspot-leads-may2026.json');
  const raw = await fs.readFile(cachePath, 'utf8');
  const json = JSON.parse(raw);
  const all: HsLead[] = (json.addressable || []).map((a: any) => ({
    id: a.email, // we don't have HS ids in the cache; email serves as a stable identifier here
    email: a.email,
    firstName: a.first || null,
    lastName: a.last || null,
    company: a.company || null,
    createdAt: a.created || '',
    lastDemo: a.demo || null,
  }));
  console.log(`Loaded ${all.length} addressable leads from cache (pulled ${json.pulled_at}).`);
  return all;
}

// Domains we always exclude (existing customers, partners, internal, investors)
const EXCLUDE_DOMAINS = new Set([
  // Existing customers / their parent orgs
  'tmcfinancing.com', 'teamcenterstone.com', 'statewidecdc.com', 'getclearfirm.com',
  // Internal
  'moderntax.io', 'rapidlyfinancial.com',
  // Investors / partners / industry contacts (won't buy verifications)
  'muckercapital.com', 'sheridancapital.com', 'wolterskluwer.com', 'customersbank.com',
  'besmartee.com', 'libertymutual.com', 'lama.ai', 'altaclub.vc',
  'greenhillsventures.com', 'sba.gov',
  // Major data competitors / partners
  'experian.com',
  // Mis-targeted in May 1+4 batches (Matt review 2026-05-04). Industry orgs,
  // PE/VC, risk insurance, event services, accelerators, foreign legal, etc.
  'naggl.org', '43north.org', 'ftcafe.org',
  'wpp.com', 'wfp.org', 'monaco.com',
  'rizerisk.com', 'eventfullyyourz.com',
  'gener8tor.com', 'battery.com', 'serentcapital.com', 'mpkequitypartners.com',
  'remitian.com', 'admlegal.rs', 'lrmlenderconsultants.com',
  'ampbusinessvaluations.com', 'sbp-online.com',
]);

// Specific emails to exclude (internal contractors, test accounts)
const EXCLUDE_EMAILS = new Set([
  'calculatednumbers@gmail.com',  // LaTonya - expert
  'matthewaparker@icloud.com',    // Matt's testing account
]);

// Personal email providers — typically signers (taxpayers/borrowers) who
// got into HubSpot via 8821 flows, not actual lender prospects. Skip
// unless their company name signals a likely lender contact.
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

/** Read/write the persistent record of who's already received the campaign. */
async function loadSentLog(): Promise<Set<string>> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const p = path.join(process.cwd(), 'scripts/data/may2026-sent.json');
  try {
    const raw = await fs.readFile(p, 'utf8');
    const json = JSON.parse(raw);
    return new Set((json.sent || []).map((s: any) => (s.email || s).toLowerCase()));
  } catch {
    return new Set();
  }
}

async function appendSentLog(records: { email: string; segment: string; sentAt: string }[]) {
  const fs = await import('fs/promises');
  const path = await import('path');
  const p = path.join(process.cwd(), 'scripts/data/may2026-sent.json');
  let existing: any = { sent: [] };
  try {
    existing = JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {}
  existing.sent = (existing.sent || []).concat(records);
  await fs.writeFile(p, JSON.stringify(existing, null, 2));
}

async function sendLenderCampaign() {
  console.log('Fetching HubSpot leads (createdate >= 2025-01-01, lifecyclestage = lead)...');
  let leads: HsLead[];
  try {
    leads = await fetchHubspotLeads();
  } catch (err) {
    console.error('HubSpot fetch failed:', (err as Error).message);
    console.error('HUBSPOT_PRIVATE_APP_TOKEN missing - falling back to MCP-pulled cache for now.');
    return;
  }
  console.log(`Total leads fetched: ${leads.length}`);

  // Filter (defensive — cache is pre-filtered, but keep this as a safety belt).
  // Tracks per-reason skips so the operator can see *why* contacts dropped.
  const skipReasons: Record<string, number> = {};
  const addressable = leads.filter(l => {
    if (EXCLUDE_EMAILS.has(l.email)) {
      skipReasons['excluded-email'] = (skipReasons['excluded-email'] || 0) + 1;
      return false;
    }
    const domain = l.email.split('@')[1] || '';
    if (EXCLUDE_DOMAINS.has(domain)) {
      skipReasons[`domain:${domain}`] = (skipReasons[`domain:${domain}`] || 0) + 1;
      return false;
    }
    if (PERSONAL_EMAIL_DOMAINS.has(domain) && !isLenderCompany(l.company)) {
      skipReasons['personal-email-no-lender-company'] = (skipReasons['personal-email-no-lender-company'] || 0) + 1;
      return false;
    }
    return true;
  });
  console.log(`Addressable after filtering: ${addressable.length}`);
  if (Object.keys(skipReasons).length > 0) {
    console.log(`Skipped: ${Object.entries(skipReasons).map(([r, c]) => `${r}=${c}`).join(', ')}`);
  }

  // Skip anyone already sent this campaign (persists across runs in
  // scripts/data/may2026-sent.json). Keeps the daily 25/day rhythm
  // idempotent — re-running picks up where we left off without re-mailing.
  const sentLog = testTo ? new Set<string>() : await loadSentLog();
  const unsent = addressable.filter(l => !sentLog.has(l.email));
  console.log(`Already sent in prior runs: ${addressable.length - unsent.length}`);
  console.log(`Remaining to mail: ${unsent.length}`);

  // Effective batch size:
  //   --test-to=...      → 1 (sample preview)
  //   --limit N          → first N (manual override)
  //   default            → 25 (Matt's chosen daily cadence to protect
  //                         sender reputation + give time for stats review)
  const DAILY_BATCH = 25;
  const effectiveLimit = testTo ? 1 : (limit > 0 ? limit : DAILY_BATCH);
  const trimmed = unsent.slice(0, effectiveLimit);
  console.log(`Will ${send ? 'SEND' : '[dry-run] preview'} ${trimmed.length} email${trimmed.length === 1 ? '' : 's'}${testTo ? ` (test-to: ${testTo})` : ''}`);

  let sent = 0;
  let failed = 0;
  const sentRecords: { email: string; segment: string; sentAt: string }[] = [];
  for (const lead of trimmed) {
    const firstName = lead.firstName || lead.email.split('@')[0].split('.')[0];
    const greeting = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
    const ts = lead.lastDemo || lead.createdAt;
    const lastTouchLabel = ts
      ? new Date(ts).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : 'when we last connected';

    const bodyHtml = `
<p>Hi ${escapeHtml(greeting)},</p>
<p>Quick update on what we've shipped at ModernTax since ${escapeHtml(lastTouchLabel)} — and an open invitation to try the platform free this month.</p>
<h3 style="font-size:16px;color:#0a1929;margin:28px 0 10px 0;">What's new since you last looked</h3>
<ul style="line-height:1.85;padding-left:20px;margin:0 0 18px 0;">
<li><strong>24-48 hour delivery</strong> on all IRS transcript pulls (down from the 10-day Tax Guard standard).</li>
<li><strong>Real-time status tracking</strong> — pulls move from "8821 sent" → "IRS queue" → "delivered" without refreshing.</li>
<li><strong>Automatic 8821 generation + e-signature</strong>. CSV upload, taxpayer signs from email, transcripts arrive. No PDF wrangling.</li>
<li><strong>Compliance flag rollups</strong> — every transcript scanned for unfiled returns, balances due, liens, levies, audit indicators. CRITICAL/WARNING/CLEAN summary delivered with each pull.</li>
<li><strong>IRS Direct Sync</strong> — when IRS systems are live, transcripts sync to your portal automatically.</li>
<li><strong>Account monitoring</strong> — enroll a TIN once, get notified the moment the account changes (new lien, payment posted, return filed).</li>
</ul>
<h3 style="font-size:16px;color:#0a1929;margin:28px 0 10px 0;">Industry reads from our blog</h3>
<p style="margin:0 0 14px 0;">We publish weekly briefs on what's changing at the IRS, how SBA underwriters are adapting, and what we're learning from running ${escapeHtml('thousands')} of verifications a month. Subscribe at <a href="${SUBSTACK_URL}" style="color:#0066cc;">moderntax.substack.com</a>.</p>
<h3 style="font-size:16px;color:#0a1929;margin:28px 0 10px 0;">Try the platform — first 3 verifications are free</h3>
<ol style="line-height:1.85;padding-left:20px;margin:0 0 18px 0;">
<li>Sign up at <a href="${PORTAL_SIGNUP}" style="color:#0066cc;font-weight:600;">portal.moderntax.io/signup</a> (60 seconds, no credit card)</li>
<li>The product tour walks you through your first verification end-to-end</li>
<li>Your first 3 verifications are on us — see the real platform with your own loan files</li>
</ol>
<p style="text-align:center;margin:28px 0;">
<a href="${PORTAL_SIGNUP}" style="display:inline-block;background:#00C48C;color:#fff;padding:14px 36px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">Start Free Trial &nbsp;&rarr;</a>
</p>
<p style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px 16px;margin:24px 0;border-radius:4px;font-size:14px;color:#78350f;"><strong>Skip the 1:1 demos:</strong> we now run a weekly group walkthrough every Thursday 10 AM PT. Same content, you can ask questions alongside other lenders. Reply to this email with "RSVP" and we'll send the calendar invite for the next one.</p>
<p style="font-size:14px;color:#444;">Reply with questions — happy to help your team get started.</p>
<p style="margin-top:24px;">Matt Parker<br><span style="color:#666;">Founder, ModernTax</span></p>`;

    const html = marketingShell({
      preheader: `What's new at ModernTax + free trial for your team this month.`,
      bodyHtml,
    });

    if (!send) {
      console.log(`  [dry-run] -> ${lead.email} (${greeting}, last touch ${lastTouchLabel})`);
      sent++;
      continue;
    }
    const recipient = testTo || lead.email;
    const subjectLine = `${testTo ? '[TEST] ' : ''}What's new at ModernTax — and a free trial for your team this month`;
    try {
      await sgMail.send({
        to: recipient,
        from: { email: FROM_EMAIL, name: FROM_NAME },
        replyTo: REPLY_TO,
        subject: subjectLine,
        html,
        categories: ['may2026', 'lender_reactivation', ...(testTo ? ['test_send'] : [])],
        customArgs: { segment: 'lenders', original_recipient: lead.email },
      });
      sent++;
      if (!testTo) {
        sentRecords.push({ email: lead.email, segment: 'lenders', sentAt: new Date().toISOString() });
      }
      if (sent % 25 === 0) console.log(`  ...${sent} sent`);
      // Light throttle to be nice to SendGrid
      await new Promise(r => setTimeout(r, 50));
    } catch (err) {
      failed++;
      console.error(`  FAIL ${recipient}:`, (err as Error).message);
    }
  }
  if (sentRecords.length > 0) await appendSentLog(sentRecords);
  console.log(`\nLender campaign: ${sent} ${send ? 'sent' : 'previewed'}, ${failed} failed`);
  console.log(`Remaining after this batch: ${unsent.length - sent}`);
}

// ---------------------------------------------------------------------------
// Segment C — Borrower / SBA-applicant outreach (personal-email leads
// caught in HubSpot from past 8821 signer flows)
//
// Inverse of the lender filter: only personal-email domains, only
// contacts whose company doesn't signal a lender. These are typically
// small business owners who signed an 8821 for an SBA loan and got
// pulled into HubSpot as a contact. They're not lender prospects but
// they ARE qualified prospects for our SBA compliance / tax prep /
// refund credit / pre-approval check-up services.
// ---------------------------------------------------------------------------

async function sendBorrowerCampaign() {
  console.log('Loading HubSpot leads from cache for borrower segment...');
  let leads: HsLead[];
  try {
    leads = await fetchHubspotLeads();
  } catch (err) {
    console.error('HubSpot fetch failed:', (err as Error).message);
    return;
  }

  // Inverse filter: keep ONLY personal-email + non-lender-company contacts.
  // Still apply the exclude-emails list for internal safety.
  const borrowerProspects = leads.filter(l => {
    if (EXCLUDE_EMAILS.has(l.email)) return false;
    const domain = l.email.split('@')[1] || '';
    if (!PERSONAL_EMAIL_DOMAINS.has(domain)) return false;
    if (isLenderCompany(l.company)) return false;
    return true;
  });
  console.log(`Borrower prospects (personal-email, non-lender company): ${borrowerProspects.length}`);

  // Dedupe — skip anyone already sent from this segment OR the lender segment.
  // (Don't double-mail someone who got the lender pitch by mistake earlier.)
  const sentLog = testTo ? new Set<string>() : await loadSentLog();
  const unsent = borrowerProspects.filter(l => !sentLog.has(l.email));
  console.log(`Already sent: ${borrowerProspects.length - unsent.length}`);
  console.log(`Remaining to mail: ${unsent.length}`);

  // Default: send all in one go for borrowers (small list ~50). Allow --limit override.
  const effectiveLimit = testTo ? 1 : (limit > 0 ? limit : unsent.length);
  const trimmed = unsent.slice(0, effectiveLimit);
  console.log(`Will ${send ? 'SEND' : '[dry-run] preview'} ${trimmed.length} email${trimmed.length === 1 ? '' : 's'}${testTo ? ` (test-to: ${testTo})` : ''}`);

  let sent_ = 0;
  let failed = 0;
  const sentRecords: { email: string; segment: string; sentAt: string }[] = [];

  for (const lead of trimmed) {
    const firstName = lead.firstName || lead.email.split('@')[0].split('.')[0];
    const greeting = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
    const company = lead.company ? ` for ${lead.company}` : '';

    const bodyHtml = `
<p>Hi ${escapeHtml(greeting)},</p>
<p>You signed an IRS Form 8821 with us recently as part of an SBA loan application${escapeHtml(company)}. We're ModernTax — the tax verification platform your lender uses to pull IRS transcripts.</p>
<p>Quick offer: while we have your authorization on file, we can do a few things to help on the tax side that most SBA borrowers leave on the table.</p>

<h3 style="font-size:16px;color:#0a1929;margin:28px 0 10px 0;">Four ways we can help</h3>

<div style="background:#f0fdf4;border-left:4px solid #00C48C;padding:14px 18px;margin:14px 0;border-radius:4px;">
<p style="margin:0 0 6px 0;"><strong>1. SBA Compliance Check-Up</strong> &nbsp;<em style="color:#15803d;font-size:13px;">free</em></p>
<p style="margin:0;font-size:14px;color:#444;">15-minute review of your IRS standing — unfiled returns, balances due, liens, levies, audit indicators. Useful before applying for the next loan or refinance.</p>
</div>

<div style="background:#eff6ff;border-left:4px solid #2563eb;padding:14px 18px;margin:14px 0;border-radius:4px;">
<p style="margin:0 0 6px 0;"><strong>2. Refund &amp; Credit Assessment</strong> &nbsp;<em style="color:#1d4ed8;font-size:13px;">contingency-based</em></p>
<p style="margin:0;font-size:14px;color:#444;">We scan your transcripts for unclaimed refunds, ERC, R&amp;D credits, energy credits, and other money the IRS may owe you. We only get paid if we recover something.</p>
</div>

<div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:14px 18px;margin:14px 0;border-radius:4px;">
<p style="margin:0 0 6px 0;"><strong>3. Pre-Approval Tax Check-In</strong> &nbsp;<em style="color:#92400e;font-size:13px;">before your next loan</em></p>
<p style="margin:0;font-size:14px;color:#444;">Underwriters look for the same red flags every time. We check your IRS records before you apply — so you walk in knowing the answer.</p>
</div>

<div style="background:#fdf4ff;border-left:4px solid #a855f7;padding:14px 18px;margin:14px 0;border-radius:4px;">
<p style="margin:0 0 6px 0;"><strong>4. Tax Prep &amp; Resolution</strong> &nbsp;<em style="color:#7c3aed;font-size:13px;">starting at \$300</em></p>
<p style="margin:0;font-size:14px;color:#444;">Quarterly estimates, S-corp election, business returns, installment agreements, penalty abatement. We do this work daily for SBA borrowers.</p>
</div>

<p style="text-align:center;margin:28px 0;">
<a href="${HUBSPOT_BOOKING}" style="display:inline-block;background:#00C48C;color:#fff;padding:14px 36px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">Book a 15-minute review &nbsp;&rarr;</a>
</p>

<p style="font-size:14px;color:#444;">No obligation. If everything looks clean, we'll tell you that and you'll have one less thing to worry about. If we find something, you'll know what to do about it.</p>
<p style="margin-top:24px;">Matt Parker<br><span style="color:#666;">Founder, ModernTax</span></p>`;

    const html = marketingShell({
      preheader: 'Free SBA compliance check-up + refund/credit assessment for past 8821 signers.',
      bodyHtml,
    });

    if (!send) {
      console.log(`  [dry-run] -> ${lead.email} (${greeting}, ${lead.company || 'no company'})`);
      sent_++;
      continue;
    }
    const recipient = testTo || lead.email;
    const subject = `${testTo ? '[TEST] ' : ''}${greeting} - free SBA compliance check-up + refund credit scan`;
    try {
      await sgMail.send({
        to: recipient,
        from: { email: FROM_EMAIL, name: FROM_NAME },
        replyTo: REPLY_TO,
        subject,
        html,
        categories: ['may2026', 'borrower_outreach', ...(testTo ? ['test_send'] : [])],
        customArgs: { segment: 'borrowers', original_recipient: lead.email },
      });
      sent_++;
      if (!testTo) {
        sentRecords.push({ email: lead.email, segment: 'borrowers', sentAt: new Date().toISOString() });
      }
      await new Promise(r => setTimeout(r, 50));
    } catch (err) {
      failed++;
      console.error(`  FAIL ${recipient}:`, (err as Error).message);
    }
  }
  if (sentRecords.length > 0) await appendSentLog(sentRecords);
  console.log(`\nBorrower campaign: ${sent_} ${send ? 'sent' : 'previewed'}, ${failed} failed`);
}

// ---------------------------------------------------------------------------
// Segment B — Compliance prospects
// ---------------------------------------------------------------------------

async function sendComplianceCampaign() {
  const { data: rows } = await supabase
    .from('request_entities')
    .select('id, entity_name, signer_email, signer_first_name, form_type, gross_receipts, completed_at, ' +
      'requests ( clients ( name ) )')
    .not('signer_email', 'is', null)
    .not('signature_id', 'is', null)
    .not('gross_receipts', 'is', null) as { data: any[] | null };

  if (!rows || rows.length === 0) {
    console.log('[compliance] no flagged prospects to send');
    return;
  }

  // Group by signer_email — one email per taxpayer summarizing all their flagged entities
  const byEmail = new Map<string, {
    email: string; firstName: string;
    items: { entityName: string; formType: string; lenderName: string;
             pullDate: string; flags: { severity: string; type: string; message: string }[] }[];
  }>();

  for (const r of rows) {
    const email = (r.signer_email || '').toLowerCase();
    if (!email) continue;
    const gr = r.gross_receipts || {};
    const flags: { severity: string; type: string; message: string }[] = [];
    for (const [, v] of Object.entries(gr)) {
      if (v && typeof v === 'object' && Array.isArray((v as any).flags)) {
        for (const f of (v as any).flags) {
          flags.push({
            severity: f.severity || '',
            type: f.type || '',
            message: f.message || '',
          });
        }
      }
    }
    if (flags.length === 0) continue;

    let g = byEmail.get(email);
    if (!g) {
      g = { email, firstName: r.signer_first_name || email.split('@')[0].split('.')[0], items: [] };
      byEmail.set(email, g);
    }
    g.items.push({
      entityName: r.entity_name || '(your entity)',
      formType: r.form_type || '-',
      lenderName: r.requests?.clients?.name || 'your lender',
      pullDate: r.completed_at ? new Date(r.completed_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'recently',
      flags,
    });
  }

  // Persistent dedupe: skip prospects already sent this campaign
  const sentLog = testTo ? new Set<string>() : await loadSentLog();
  const allEntries = Array.from(byEmail.entries());
  const unsentEntries = allEntries.filter(([email]) => !sentLog.has(email));
  console.log(`[compliance] ${byEmail.size} unique recipients (${allEntries.length - unsentEntries.length} already sent, ${unsentEntries.length} remaining)${testTo ? ` (test-to: ${testTo}, sampling 1)` : ''}`);

  let sent = 0; let failed = 0;
  const sentRecords: { email: string; segment: string; sentAt: string }[] = [];
  // In test-to mode, send only the first one (the highest-flag-count taxpayer
  // is preferred for preview because it shows the multi-flag layout).
  const entries = testTo
    ? allEntries.slice(0, 1)
    : unsentEntries;
  for (const [, g] of entries) {
    const firstName = g.firstName.charAt(0).toUpperCase() + g.firstName.slice(1).toLowerCase();
    // Aggregate flag descriptions across this taxpayer's entities
    const flagItems = g.items.flatMap(it => it.flags.map(f => ({
      severity: f.severity, type: f.type, message: f.message,
      entity: it.entityName, lender: it.lenderName, pullDate: it.pullDate,
    })));
    const totalFlags = flagItems.length;
    const flagListHtml = flagItems.slice(0, 6).map(f =>
      `<li style="margin-bottom:8px;"><strong style="color:${f.severity === 'CRITICAL' ? '#dc2626' : '#d97706'};">${escapeHtml(f.severity)}</strong> on <strong>${escapeHtml(f.entity)}</strong> (pulled by ${escapeHtml(f.lender)} on ${escapeHtml(f.pullDate)}): ${escapeHtml(f.message || f.type)}</li>`
    ).join('');

    const bodyHtml = `
<p>Hi ${escapeHtml(firstName)},</p>
<p>When we pulled your IRS transcripts on behalf of your lender, our compliance system flagged <strong>${totalFlags}</strong> ${totalFlags === 1 ? 'item' : 'items'} that may impact future loans, professional licenses, or government applications:</p>
<ul style="line-height:1.7;padding-left:20px;margin:18px 0;">${flagListHtml}</ul>
<p>Most of these are resolvable — sometimes in a single phone call to the IRS, sometimes with a payment plan, amended return, or installment agreement. We do this work daily for SBA borrowers and small business owners.</p>
<p style="background:#f0fdf4;border-left:4px solid #00C48C;padding:14px 18px;margin:24px 0;border-radius:4px;"><strong>No-cost 15-minute review.</strong> I'll explain what's flagged, what it means, and what it'd take to clear it. If you want help, our resolution service starts at $300.</p>
<p style="text-align:center;margin:28px 0;">
<a href="${HUBSPOT_BOOKING}" style="display:inline-block;background:#00C48C;color:#fff;padding:14px 36px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">Book a free 15-minute review &nbsp;&rarr;</a>
</p>
<p style="font-size:13px;color:#666;">If you've already addressed this, ignore this email — your IRS account will update on the next monitoring pull.</p>
<p style="margin-top:24px;">Matt Parker<br><span style="color:#666;">ModernTax</span></p>`;

    const html = marketingShell({
      preheader: `Your IRS account flagged ${totalFlags} ${totalFlags === 1 ? 'item' : 'items'} that need attention.`,
      bodyHtml,
    });

    const subject = `${testTo ? '[TEST] ' : ''}${firstName} - your IRS account flagged ${totalFlags} ${totalFlags === 1 ? 'item' : 'items'} that need attention`;

    if (!send) {
      console.log(`  [dry-run] -> ${g.email} (${firstName}, ${totalFlags} flags)`);
      sent++;
      continue;
    }
    const recipient = testTo || g.email;
    try {
      await sgMail.send({
        to: recipient,
        from: { email: FROM_EMAIL, name: FROM_NAME },
        replyTo: REPLY_TO,
        subject,
        html,
        categories: ['may2026', 'compliance_outreach', ...(testTo ? ['test_send'] : [])],
        customArgs: { segment: 'compliance', flag_count: String(totalFlags), original_recipient: g.email },
      });
      sent++;
      if (!testTo) {
        sentRecords.push({ email: g.email, segment: 'compliance', sentAt: new Date().toISOString() });
      }
    } catch (err) {
      failed++;
      console.error(`  FAIL ${recipient}:`, (err as Error).message);
    }
  }
  if (sentRecords.length > 0) await appendSentLog(sentRecords);
  console.log(`\nCompliance campaign: ${sent} ${send ? 'sent' : 'previewed'}, ${failed} failed`);
}

function escapeHtml(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function main() {
  console.log(`May Marketing Campaign — ${send ? 'SEND' : '[dry-run]'} mode\n`);
  if (target === 'lenders' || target === 'all') await sendLenderCampaign();
  if (target === 'compliance' || target === 'all') await sendComplianceCampaign();
  if (target === 'borrowers' || target === 'all') await sendBorrowerCampaign();
  if (!send) console.log('\nDRY-RUN. Re-run with --send to fire for real.');
}
main().catch(e => { console.error(e); process.exit(1); });
