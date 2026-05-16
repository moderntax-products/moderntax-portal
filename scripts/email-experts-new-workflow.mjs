/**
 * One-off email blast to all current experts announcing the supply-demand
 * batch acceptance workflow (shipped 2026-05-16, commits ec81518 + 1f5d4e6).
 *
 * Personalized per recipient based on profile completeness:
 *   · Joel (incomplete creds) → BIG yellow "Step 1: complete profile" CTA
 *   · LaTonya + Matt (complete creds) → "You're set, first batch coming" version
 *
 * Run once: `npx -y tsx scripts/email-experts-new-workflow.mjs`
 */

import sgMail from '@sendgrid/mail';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const FROM = process.env.SENDGRID_FROM_EMAIL || 'active-accounts@moderntax.io';
const APP = 'https://portal.moderntax.io';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

function isComplete(p) {
  return !!(p.full_name?.trim() && p.caf_number?.trim() && p.ptin?.trim() && p.phone_number?.trim());
}

function firstName(p) {
  return (p.full_name || '').trim().split(/\s+/)[0] || 'there';
}

function buildEmail({ profile, complete }) {
  const fname = firstName(profile);

  // Shared body — workflow overview
  const workflowSection = `
<h2 style="font-size:18px;color:#0A1929;margin:24px 0 8px;">What's changing — supply-demand batch workflow</h2>
<p>Starting now, you'll receive <strong>batches of 3–5 entities</strong> at a time instead of one-off direct assignments. Here's the flow:</p>

<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
  <tr style="background:#f5f5f5;">
    <td style="padding:10px 12px;border:1px solid #e5e5e5;font-weight:600;width:130px;">Offer arrives</td>
    <td style="padding:10px 12px;border:1px solid #e5e5e5;">You'll see a yellow "New Batch Offered" card at the top of <a href="${APP}/expert" style="color:#00C48C;">your dashboard</a> with a live 30-minute countdown.</td>
  </tr>
  <tr>
    <td style="padding:10px 12px;border:1px solid #e5e5e5;font-weight:600;">⏱ 30 minutes to accept</td>
    <td style="padding:10px 12px;border:1px solid #e5e5e5;">Review the entities (client, form type, years). Accept the batch OR decline with a reason. If you do nothing, the batch automatically returns to the pool and gets offered to another available expert.</td>
  </tr>
  <tr style="background:#f5f5f5;">
    <td style="padding:10px 12px;border:1px solid #e5e5e5;font-weight:600;">On Accept</td>
    <td style="padding:10px 12px;border:1px solid #e5e5e5;">All 8821 PDFs are <strong>regenerated with your CAF, PTIN, and phone</strong> — no more designee mismatches with IRS. The fresh PDFs land on each assignment automatically.</td>
  </tr>
  <tr>
    <td style="padding:10px 12px;border:1px solid #e5e5e5;font-weight:600;">⏱ 24 hours to complete</td>
    <td style="padding:10px 12px;border:1px solid #e5e5e5;">Standard expert workflow — call IRS PPS, pull transcripts, upload. You can run up to 3 AI-assisted calls concurrently from the dashboard.</td>
  </tr>
</table>

<h3 style="font-size:15px;color:#0A1929;margin:20px 0 6px;">A few important rules</h3>
<ul style="margin:6px 0 16px;padding-left:22px;line-height:1.7;">
  <li>You can only have <strong>one active batch at a time</strong> — finish the current one (or wait for it to complete) before a new offer appears.</li>
  <li>If you decline or let a batch expire, no penalty — it just goes back to the pool. We'd rather you decline a bad fit than accept and underdeliver.</li>
  <li>Reasons help us route better next time — please share why if you decline.</li>
  <li>Same-day close-out is the goal. If you accept in the morning, plan to finish that day.</li>
</ul>
  `.trim();

  // Personalized opening
  const incompleteCallout = !complete ? `
<div style="background:#FEF3C7;border:2px solid #F59E0B;border-radius:8px;padding:20px;margin:16px 0;">
  <div style="font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#92400E;margin-bottom:6px;">Step 1 — before you can receive batches</div>
  <p style="margin:0 0 12px;color:#1a1a1a;">Your profile is missing the IRS designee fields we need (CAF, PTIN, phone). The system literally cannot route assignments to you until those are populated — the 8821 needs YOUR credentials to be valid for YOUR PPS calls.</p>
  <p style="margin:0;text-align:center;">
    <a href="${APP}/expert/profile" style="display:inline-block;background-color:#F59E0B;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Complete your profile (2 min) →</a>
  </p>
  <p style="margin:12px 0 0;font-size:12px;color:#78350F;text-align:center;">Once you're done, the next 30-minute auto-batcher run will offer you your first batch.</p>
</div>
  `.trim() : '';

  const completeBlock = complete ? `
<div style="background:#D1FAE5;border:1px solid #10B981;border-radius:8px;padding:16px;margin:16px 0;">
  <div style="font-weight:600;color:#065F46;margin-bottom:6px;">✓ Your profile is complete</div>
  <p style="margin:0;color:#1a1a1a;font-size:14px;">CAF, PTIN, and phone are on file. The first auto-batch run after this email lands will offer you a batch within ~30 minutes. Just be on the lookout for your dashboard's new batch card.</p>
</div>
  `.trim() : '';

  const content = `
<p>Hi ${fname},</p>

<p>Quick heads-up: we shipped a new expert workflow tonight. Same work, much cleaner intake — and it eliminates a class of bug where the 8821 on your assignment listed the wrong designee.</p>

${incompleteCallout}
${completeBlock}
${workflowSection}

<p>Reply to this email with any questions — I'm in the inbox daily. Excited to ship faster turnarounds with this workflow.</p>

<p style="margin-top:24px;">— Matt</p>
  `.trim();

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#1a1a1a;background-color:#f5f5f5;margin:0;padding:0;">
<div style="max-width:640px;margin:0 auto;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
  <div style="background:linear-gradient(135deg,#0A1929 0%,#102A43 100%);color:#ffffff;padding:28px 24px;text-align:center;border-bottom:4px solid #00C48C;">
    <div style="font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;opacity:0.8;">ModernTax · Expert Workflow Update</div>
    <h1 style="margin:0;font-size:22px;font-weight:600;letter-spacing:-0.5px;">New: Batch Acceptance Workflow</h1>
  </div>
  <div style="padding:28px 32px;color:#1a1a1a;font-size:15px;">
    ${content}
  </div>
  <div style="padding:16px;text-align:center;font-size:11px;color:#999;background-color:#fafafa;border-top:1px solid #eee;">
    ModernTax · <a href="mailto:matt@moderntax.io" style="color:#999;">matt@moderntax.io</a>
  </div>
</div>
</body></html>`;
}

// ─── Send ────────────────────────────────────────────────────────────────
const { data: experts } = await sb.from('profiles')
  .select('id, email, full_name, caf_number, ptin, phone_number')
  .eq('role', 'expert')
  .order('full_name');

console.log(`Sending to ${experts?.length || 0} experts:\n`);
for (const p of experts || []) {
  const complete = isComplete(p);
  const html = buildEmail({ profile: p, complete });
  const subject = complete
    ? `New batch workflow is live — you're set, first offer coming soon`
    : `New batch workflow — Joel, one quick step to start receiving assignments`;

  try {
    await sgMail.send({
      to: p.email,
      from: { email: FROM, name: 'Matt Parker · ModernTax' },
      subject,
      html,
      replyTo: 'matt@moderntax.io',
    });
    console.log(`  ✓ ${p.full_name?.padEnd(40) || p.email.padEnd(40)} | ${complete ? 'complete' : 'INCOMPLETE — got profile callout'}`);
  } catch (err) {
    console.error(`  ✗ ${p.email}: ${err.message || err}`);
  }
}
console.log('\nDone.');
