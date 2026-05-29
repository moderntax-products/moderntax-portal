/**
 * Compliance Drip Email Engine
 * Sends segmented, multi-stage email sequences to entities with IRS compliance flags.
 * Each stage escalates urgency and includes entity-specific dollar amounts.
 */

import sgMail from '@sendgrid/mail';

const sendGridApiKey = process.env.SENDGRID_API_KEY;
if (sendGridApiKey) sgMail.setApiKey(sendGridApiKey);

const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io';
const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

// --- Types ---

export type FlagCategory = 'balance_due' | 'unfiled_returns' | 'penalties' | 'mixed' | 'other';

export interface ComplianceDripRecord {
  id: string;
  entity_id: string;
  resolve_token: string;
  flag_category: FlagCategory;
  flag_severity: string;
  balance_due: number | null;
  accrued_penalty: number | null;
  accrued_interest: number | null;
  total_exposure: number | null;
  drip_stage: number;
  signer_email: string;
  signer_name: string | null;
  entity_name: string;
  unsubscribed: boolean;
  consultation_booked: boolean;
}

export interface ComplianceFlags {
  severity: string;
  flags: { message: string; severity: string }[];
  financials?: {
    grossReceipts?: number | null;
    totalIncome?: number | null;
    totalDeductions?: number | null;
    totalTax?: number | null;
    accountBalance?: number | null;
    accruedInterest?: number | null;
    accruedPenalty?: number | null;
  };
}

// --- Flag Classification ---

export function classifyFlags(grossReceipts: Record<string, any>): {
  category: FlagCategory;
  severity: string;
  balanceDue: number;
  penalty: number;
  interest: number;
  totalExposure: number;
  allFlags: { message: string; severity: string }[];
} {
  let balanceDue = 0;
  let penalty = 0;
  let interest = 0;
  let hasBalanceDue = false;
  let hasUnfiled = false;
  let hasPenalties = false;
  let maxSeverity = 'WARNING';
  const allFlags: { message: string; severity: string }[] = [];

  for (const [, val] of Object.entries(grossReceipts)) {
    if (!val || typeof val !== 'object' || !val.severity) continue;
    if (val.severity === 'CRITICAL') maxSeverity = 'CRITICAL';

    for (const flag of (val.flags || [])) {
      allFlags.push(flag);
      const msg = (flag.message || '').toLowerCase();
      if (msg.includes('balance') || msg.includes('amount due') || msg.includes('owe')) hasBalanceDue = true;
      if (msg.includes('unfiled') || msg.includes('no return') || msg.includes('not filed')) hasUnfiled = true;
      if (msg.includes('penalty') || msg.includes('penalt')) hasPenalties = true;
    }

    if (val.financials) {
      balanceDue += Math.abs(val.financials.accountBalance || 0);
      penalty += Math.abs(val.financials.accruedPenalty || 0);
      interest += Math.abs(val.financials.accruedInterest || 0);
    }
  }

  let category: FlagCategory = 'other';
  const flagTypes = [hasBalanceDue, hasUnfiled, hasPenalties].filter(Boolean).length;
  if (flagTypes > 1) category = 'mixed';
  else if (hasBalanceDue) category = 'balance_due';
  else if (hasUnfiled) category = 'unfiled_returns';
  else if (hasPenalties) category = 'penalties';

  return {
    category,
    severity: maxSeverity,
    balanceDue,
    penalty,
    interest,
    totalExposure: balanceDue + penalty + interest,
    allFlags,
  };
}

// --- Dollar Formatting ---

function fmt(n: number | null | undefined): string {
  if (!n || n === 0) return '$0';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

// --- Email Templates ---

function emailWrapper(content: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; background-color: #f5f5f5; margin: 0; padding: 20px;">
<div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
  <div style="background: linear-gradient(135deg, #0A1929 0%, #102A43 100%); color: #ffffff; padding: 32px 24px; text-align: center; border-bottom: 4px solid #00C48C;">
    <div style="font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; opacity: 0.8;">ModernTax</div>
    <h1 style="margin: 0; font-size: 22px; font-weight: 600;">Tax Compliance Review</h1>
  </div>
  <div style="padding: 32px 24px; color: #1a1a1a; font-size: 15px; line-height: 1.8;">
    ${content}
  </div>
  <div style="padding: 16px 24px; background: #f9fafb; border-top: 1px solid #e5e7eb; text-align: center;">
    <p style="color: #9ca3af; font-size: 12px; margin: 0;">ModernTax — Tax Compliance & Resolution Services</p>
    <p style="color: #9ca3af; font-size: 11px; margin: 4px 0 0;"><a href="{{unsubscribe_url}}" style="color: #9ca3af;">Unsubscribe</a></p>
  </div>
</div>
</body>
</html>`;
}

function flagsHtml(flags: { message: string; severity: string }[]): string {
  const critical = flags.filter(f => f.severity === 'CRITICAL');
  const warning = flags.filter(f => f.severity === 'WARNING');
  let html = '';
  if (critical.length) {
    html += `<div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin: 16px 0;">
      <h3 style="color: #dc2626; margin: 0 0 8px; font-size: 14px;">Critical Items</h3>
      <ul style="margin: 0; padding-left: 20px;">${critical.map(f => `<li style="color: #dc2626; margin: 4px 0;">${f.message}</li>`).join('')}</ul>
    </div>`;
  }
  if (warning.length) {
    html += `<div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px; margin: 16px 0;">
      <h3 style="color: #d97706; margin: 0 0 8px; font-size: 14px;">Warnings</h3>
      <ul style="margin: 0; padding-left: 20px;">${warning.map(f => `<li style="color: #d97706; margin: 4px 0;">${f.message}</li>`).join('')}</ul>
    </div>`;
  }
  return html;
}

function exposureBox(drip: ComplianceDripRecord): string {
  if (!drip.total_exposure || drip.total_exposure === 0) return '';
  const items: string[] = [];
  if (drip.balance_due && drip.balance_due > 0) items.push(`<span style="color: #dc2626; font-weight: 600;">Balance Due: ${fmt(drip.balance_due)}</span>`);
  if (drip.accrued_penalty && drip.accrued_penalty > 0) items.push(`<span style="color: #d97706;">Penalties: ${fmt(drip.accrued_penalty)}</span>`);
  if (drip.accrued_interest && drip.accrued_interest > 0) items.push(`<span style="color: #d97706;">Interest: ${fmt(drip.accrued_interest)}</span>`);
  return `<div style="background: #fef2f2; border-left: 4px solid #dc2626; padding: 16px; margin: 16px 0; border-radius: 0 8px 8px 0;">
    <div style="font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Total IRS Exposure</div>
    <div style="font-size: 28px; font-weight: 700; color: #dc2626; margin-bottom: 8px;">${fmt(drip.total_exposure)}</div>
    <div style="font-size: 14px;">${items.join(' &nbsp;·&nbsp; ')}</div>
  </div>`;
}

function ctaButton(resolveUrl: string, text: string): string {
  return `<div style="text-align: center; margin: 24px 0;">
    <a href="${resolveUrl}" style="background: #16a34a; color: white; padding: 14px 36px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block; font-size: 16px;">${text}</a>
  </div>`;
}

// --- Stage-Specific Email Builders ---

interface EmailContent {
  subject: string;
  html: string;
}

function buildStage0(drip: ComplianceDripRecord, flags: { message: string; severity: string }[], resolveUrl: string): EmailContent {
  const name = drip.signer_name || drip.entity_name || 'there';

  const categoryIntro: Record<FlagCategory, string> = {
    balance_due: `we identified an outstanding balance with the IRS for <strong>${drip.entity_name}</strong> that requires attention`,
    unfiled_returns: `we identified unfiled tax returns for <strong>${drip.entity_name}</strong> that the IRS has flagged`,
    penalties: `we identified IRS penalties accumulating on <strong>${drip.entity_name}</strong>'s account`,
    mixed: `we identified multiple IRS compliance issues for <strong>${drip.entity_name}</strong> that need attention`,
    other: `we identified IRS compliance items for <strong>${drip.entity_name}</strong> that may require attention`,
  };

  return {
    subject: `Tax Compliance Alert: ${drip.entity_name} — Action May Be Required`,
    html: emailWrapper(`
      <p>Hi ${name},</p>
      <p>During our IRS transcript verification, ${categoryIntro[drip.flag_category]}.</p>
      ${exposureBox(drip)}
      ${flagsHtml(flags)}
      <p>Our tax resolution team specializes in exactly these situations. We can help you understand your options and create a plan to resolve this — often reducing penalties significantly.</p>
      ${ctaButton(resolveUrl, 'Review Your Compliance Report')}
      <p style="color: #6b7280; font-size: 13px;">This review is based on official IRS transcript data. For questions, reply to this email.</p>
    `).replace('{{unsubscribe_url}}', `${resolveUrl}?unsubscribe=1`),
  };
}

function buildStage1(drip: ComplianceDripRecord, resolveUrl: string): EmailContent {
  const name = drip.signer_name || drip.entity_name || 'there';
  const hasPenalties = (drip.accrued_penalty || 0) > 0;

  return {
    subject: `${drip.entity_name}: ${fmt(drip.total_exposure)} in IRS exposure — here's what's happening`,
    html: emailWrapper(`
      <p>Hi ${name},</p>
      <p>Following up on the compliance alert we sent a few days ago for <strong>${drip.entity_name}</strong>.</p>
      ${exposureBox(drip)}
      ${hasPenalties ? `<p><strong>Important:</strong> IRS penalties and interest continue to accrue daily. The longer this remains unresolved, the higher the total amount becomes. Acting now can save significant money.</p>` : ''}
      <p>Here's what a resolution typically looks like:</p>
      <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <ul style="margin: 0; padding-left: 20px; color: #166534;">
          <li style="margin: 4px 0;"><strong>Penalty abatement</strong> — First-time penalty relief can eliminate penalties entirely</li>
          <li style="margin: 4px 0;"><strong>Installment agreement</strong> — Structured payment plans to avoid levies</li>
          <li style="margin: 4px 0;"><strong>Offer in compromise</strong> — Settle for less than the full amount owed</li>
        </ul>
      </div>
      <p>A 15-minute call is all it takes to understand your options.</p>
      ${ctaButton(resolveUrl, 'See Your Options')}
    `).replace('{{unsubscribe_url}}', `${resolveUrl}?unsubscribe=1`),
  };
}

function buildStage2(drip: ComplianceDripRecord, resolveUrl: string): EmailContent {
  const name = drip.signer_name || drip.entity_name || 'there';

  return {
    subject: `Reminder: ${drip.entity_name} — IRS compliance action needed`,
    html: emailWrapper(`
      <p>Hi ${name},</p>
      <p>This is a friendly reminder about the IRS compliance items we flagged for <strong>${drip.entity_name}</strong> last week.</p>
      ${drip.total_exposure && drip.total_exposure > 0 ? `<p style="font-size: 16px;">Your current IRS exposure is <strong style="color: #dc2626;">${fmt(drip.total_exposure)}</strong> and growing.</p>` : ''}
      <p>We've helped hundreds of businesses resolve similar issues. Common outcomes include:</p>
      <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <p style="margin: 0; color: #1e40af;"><strong>Average penalty reduction:</strong> 40-60% for first-time abatement cases</p>
      </div>
      <p>Don't let this grow larger. Schedule a free 15-minute consultation and we'll map out a resolution plan.</p>
      ${ctaButton(resolveUrl, 'Schedule Free Consultation')}
      <p style="color: #6b7280; font-size: 13px;">No obligation. No pressure. Just clarity on your options.</p>
    `).replace('{{unsubscribe_url}}', `${resolveUrl}?unsubscribe=1`),
  };
}

function buildStage3(drip: ComplianceDripRecord, resolveUrl: string): EmailContent {
  const name = drip.signer_name || drip.entity_name || 'there';

  return {
    subject: `Final notice: ${drip.entity_name} — IRS penalties continue to accrue`,
    html: emailWrapper(`
      <p>Hi ${name},</p>
      <p>This is our final outreach regarding the IRS compliance flags on <strong>${drip.entity_name}</strong>.</p>
      ${drip.total_exposure && drip.total_exposure > 0 ? exposureBox(drip) : ''}
      <p>We understand you may be busy, but we want to make sure you're aware that:</p>
      <ul>
        <li>IRS penalties accrue <strong>daily</strong> — every week of delay increases your total</li>
        <li>Unresolved balances can lead to <strong>liens, levies, and wage garnishments</strong></li>
        <li>Most resolution options are <strong>time-sensitive</strong> — certain relief programs have filing deadlines</li>
      </ul>
      <p>If you'd like help, we're here. A free 15-minute call is all it takes to get started.</p>
      ${ctaButton(resolveUrl, 'Get Help Now')}
      <p style="color: #6b7280; font-size: 13px;">This will be our last email on this topic. If you've already addressed this, please disregard — and we apologize for the extra message.</p>
    `).replace('{{unsubscribe_url}}', `${resolveUrl}?unsubscribe=1`),
  };
}

// --- Public API ---

export function buildDripEmail(
  stage: number,
  drip: ComplianceDripRecord,
  flags: { message: string; severity: string }[]
): EmailContent {
  const resolveUrl = `${appUrl}/resolve/${drip.resolve_token}`;

  switch (stage) {
    case 0: return buildStage0(drip, flags, resolveUrl);
    case 1: return buildStage1(drip, resolveUrl);
    case 2: return buildStage2(drip, resolveUrl);
    case 3: return buildStage3(drip, resolveUrl);
    default: return buildStage3(drip, resolveUrl);
  }
}

/**
 * Reject signer_email values that belong to a lender/internal user
 * rather than the borrower. The compliance drip is a borrower-facing
 * nurture sequence — emailing it to a Centerstone processor or to a
 * ModernTax expert is at best ignored and at worst triggers spam reports
 * (which is what's been killing our sender reputation — see 2026-05-28
 * dashboard: 0 opens, 2 unsubs across 61 sends).
 *
 * Mechanism: look the email up in `profiles`. If a row exists, the
 * address belongs to someone with a portal account — that's never a
 * borrower. Hardcoded suffix denylist as a safety net for addresses that
 * happen to not have a profile yet (e.g. a new Centerstone employee
 * whose account isn't provisioned).
 */
const CLIENT_DOMAIN_DENYLIST = [
  'teamcenterstone.com',
  'statewidecdc.com',
  'moderntax.io',
  'moderntax.com',
];

export async function isBorrowerEmail(
  supabase: { from: (t: string) => any },
  email: string | null | undefined,
): Promise<{ ok: boolean; reason?: string }> {
  if (!email) return { ok: false, reason: 'missing email' };
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes('@')) return { ok: false, reason: 'malformed email' };

  // Suffix denylist — known lender/internal domains, no DB roundtrip needed.
  const domain = normalized.split('@')[1];
  if (CLIENT_DOMAIN_DENYLIST.some((d) => domain === d || domain.endsWith(`.${d}`))) {
    return { ok: false, reason: `domain ${domain} is denylisted (internal/lender)` };
  }

  // Profile match — if the email belongs to a portal user (any role),
  // it's not a borrower regardless of domain.
  try {
    const { data: profile } = await supabase.from('profiles')
      .select('id, role').eq('email', normalized).maybeSingle();
    if (profile?.role && ['processor', 'manager', 'admin', 'expert'].includes(profile.role)) {
      return { ok: false, reason: `email is a portal ${profile.role} account` };
    }
  } catch {
    // If the lookup errors, fail-open — better to send than miss a real
    // borrower because Supabase had a hiccup. The denylist still catches
    // the bulk of accidental sends.
  }
  return { ok: true };
}

export async function sendDripEmail(
  stage: number,
  drip: ComplianceDripRecord,
  flags: { message: string; severity: string }[],
  /**
   * Optional supabase client for the borrower-email check. When omitted,
   * only the static domain denylist applies (back-compat for older
   * callers). New code should always pass it.
   */
  supabase?: { from: (t: string) => any },
): Promise<boolean> {
  // Borrower-email guard. Driver: 2026-05-28 Matt — dashboard showed
  // 60% of compliance enrollments were going to lender processor
  // addresses, producing 0 opens + 2 unsubs. Block at the send boundary
  // so even legacy enrollments that slipped through pre-filter don't ship.
  if (supabase) {
    const check = await isBorrowerEmail(supabase, drip.signer_email);
    if (!check.ok) {
      console.warn(`[compliance-drip] suppressed stage ${stage} for ${drip.entity_name} (drip ${drip.id?.slice(0, 8) || '?'}): ${check.reason}`);
      return false;
    }
  } else {
    // Lightweight denylist-only path for callers that didn't pass a client.
    const domain = (drip.signer_email || '').trim().toLowerCase().split('@')[1] || '';
    if (CLIENT_DOMAIN_DENYLIST.some((d) => domain === d || domain.endsWith(`.${d}`))) {
      console.warn(`[compliance-drip] suppressed stage ${stage} for ${drip.entity_name} — domain ${domain} on denylist`);
      return false;
    }
  }

  const { subject, html } = buildDripEmail(stage, drip, flags);

  try {
    await sgMail.send({
      to: drip.signer_email,
      from: { email: fromEmail, name: 'ModernTax' },
      subject,
      html,
      replyTo: 'support@moderntax.io',
      trackingSettings: {
        openTracking: { enable: true },
        clickTracking: { enable: true },
      },
    });
    console.log(`[compliance-drip] Stage ${stage} email sent for ${drip.entity_name} (drip ${drip.id?.slice(0, 8) || '?'})`);
    return true;
  } catch (err) {
    console.error(`[compliance-drip] Stage ${stage} email failed for drip ${drip.id?.slice(0, 8) || '?'}:`, err);
    return false;
  }
}

// Drip schedule: days after initial flag
export const DRIP_SCHEDULE_DAYS = [0, 3, 7, 14];

export function getNextEmailDueDate(stage: number, fromDate: Date = new Date()): Date {
  const nextStage = stage + 1;
  if (nextStage >= DRIP_SCHEDULE_DAYS.length) return new Date(0); // No more emails
  const daysUntilNext = DRIP_SCHEDULE_DAYS[nextStage] - DRIP_SCHEDULE_DAYS[stage];
  const next = new Date(fromDate);
  next.setDate(next.getDate() + daysUntilNext);
  return next;
}
