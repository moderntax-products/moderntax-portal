/**
 * ModernTax Direct — monthly customer check-in.
 *
 * Builds a warm, personalized monthly status update for each PAYING Direct
 * customer whose issue isn't resolved yet, so they hear from us every month
 * until it's closed out. Pure/testable: buildCheckin() turns an entity into a
 * recipient (or null to skip), checkinEmail() renders the copy. The cron at
 * /api/cron/direct-monthly-checkin sends them (shadow-gated).
 *
 * A customer stops receiving check-ins when gross_receipts.checkin.resolved is
 * set (the team closes the case) — never on a timer.
 *
 * Matt 2026-07-28.
 */

import { detectSituation } from '@/lib/direct-purchase-order';

export interface CheckinRecipient {
  entityId: string;
  entityName: string;
  email: string;
  ownerFirstName: string;
  /** One-line "where your case stands" summary. */
  statusLine: string;
  /** What happens next / what (if anything) we need from them. */
  nextStep: string;
  /** Whether an engagement is already paid + underway. */
  engaged: boolean;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * Turn an entity into a check-in recipient, or null to skip (not a paying
 * Direct customer / already resolved / no contact email on file).
 */
export function buildCheckin(entity: any): CheckinRecipient | null {
  const gr = entity.gross_receipts || {};
  if (!gr.direct_customer?.paying) return null;
  if (gr.checkin?.resolved) return null;

  const email = gr.owner_contact?.email || gr.direct_customer?.email || null;
  if (!email) return null; // can't reach them — the sync should backfill contacts

  const ownerName = gr.owner_contact?.name || '';
  const ownerFirstName = ownerName.trim().split(/\s+/)[0] || 'there';

  const sit = detectSituation(gr, entity.form_type);
  const engagements = Array.isArray(gr.engagements) ? gr.engagements : [];
  const engaged = engagements.some((e: any) => e.status === 'paid') || gr.purchase_order?.status === 'paid';

  let statusLine: string;
  let nextStep: string;
  if (sit.payrollBalance && sit.payrollBalance > 0) {
    statusLine = `We're representing ${entity.entity_name} on about ${usd(sit.payrollPayoff || sit.payrollBalance)} of unpaid payroll tax across ${sit.payrollQuartersOpen || 'several'} quarters.`;
    nextStep = engaged
      ? 'This month our team is working your installment-agreement filing and keeping your current deposits in compliance. No action needed from you right now.'
      : 'The pre-enforcement window is still open (no lien or levy filed yet). Whenever you’re ready, approving the plan lets our experts begin.';
  } else if (sit.undeliveredRefunds && sit.undeliveredRefunds > 0) {
    statusLine = `We're working to recover ${usd(sit.undeliveredRefunds)} in refunds the IRS issued to you but never delivered.`;
    nextStep = engaged
      ? 'Your Form 3911 filing is in motion; reissued checks typically take 4–8 weeks plus mail time. We’ll flag the moment the IRS confirms.'
      : 'We just need your go-ahead (and current mailing address) to file the recovery paperwork.';
  } else if (sit.unfiledYears && sit.unfiledYears.length) {
    statusLine = `Your back-year filing covers ${sit.unfiledYears.length} delinquent return${sit.unfiledYears.length === 1 ? '' : 's'}.`;
    nextStep = engaged
      ? 'Returns are being prepared and filed to bring you current and stop the penalty clock. We’ll send copies as each is accepted.'
      : 'Once you approve, we prepare and file the returns to get you back into compliance.';
  } else {
    statusLine = `Your ModernTax case for ${entity.entity_name} is in progress.`;
    nextStep = 'Our team is monitoring your IRS account and will update you as things move. No action needed right now.';
  }

  return { entityId: entity.id, entityName: entity.entity_name, email, ownerFirstName, statusLine, nextStep, engaged };
}

export function checkinEmail(r: CheckinRecipient, monthLabel: string): { subject: string; html: string; text: string } {
  const subject = `Your ModernTax update — ${monthLabel}`;
  const text =
    `Hi ${r.ownerFirstName},\n\n` +
    `Here's your monthly update.\n\n` +
    `Where things stand: ${r.statusLine}\n\n` +
    `What's next: ${r.nextStep}\n\n` +
    `We'll check in again next month until this is fully resolved. Questions any time — just reply to this email or reach us at support@moderntax.io.\n\n` +
    `— The ModernTax team`;
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#111827;line-height:1.55">
      <p style="color:#00A57A;font-weight:800;font-size:18px;margin:0 0 16px">ModernTax</p>
      <p>Hi ${r.ownerFirstName},</p>
      <p>Here's your monthly update.</p>
      <p style="background:#f8fafc;border-left:3px solid #00A57A;padding:12px 14px;border-radius:6px">
        <strong>Where things stand:</strong> ${r.statusLine}
      </p>
      <p><strong>What's next:</strong> ${r.nextStep}</p>
      <p style="color:#6b7280;font-size:14px">We'll check in again next month until this is fully resolved. Questions any time — just reply, or reach us at
        <a href="mailto:support@moderntax.io" style="color:#00A57A">support@moderntax.io</a>.</p>
      <p>— The ModernTax team</p>
    </div>`;
  return { subject, html, text };
}
