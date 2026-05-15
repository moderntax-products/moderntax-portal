/**
 * Post-call follow-up email to Alex Marcus (Mento CEO).
 * Subject: status page is live with the full breakdown.
 * CTA: View your status page → /erc-status/mento-recovery
 *
 * Sent AFTER:
 *   · Mercury invoice MNT-MENTO-ERC-20260515-01 ($1,479) — already firing today
 *   · Vercel deploy of /erc-status/[token] route is live
 *   · Mento gross_receipts.erc_recovery seeded (scripts/seed-mento-erc-recovery.mjs)
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
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const MENTO_ENTITY_ID = 'f92264b1-d420-4865-93f0-33943fc507ff';
const ALEX_EMAIL = 'alex@mento.co';

const { data: ent } = await sb.from('request_entities')
  .select('entity_name, gross_receipts').eq('id', MENTO_ENTITY_ID).single();
const rec = ent.gross_receipts?.erc_recovery;
const token = ent.gross_receipts?.erc_recovery_token;
if (!rec || !token) { console.error('Seed data missing — run scripts/seed-mento-erc-recovery.mjs first.'); process.exit(1); }

const appUrl = 'https://portal.moderntax.io';
const statusUrl = `${appUrl}/erc-status/${token}`;
const usd = n => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const quartersRows = rec.events.map(e =>
  `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;">${e.period_ending}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">issued ${e.issued_on}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">${usd(e.amount)}</td></tr>`,
).join('');

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;line-height:1.6;color:#333;background-color:#f5f5f5;margin:0;padding:0;">
<div style="max-width:600px;margin:0 auto;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
  <div style="background:linear-gradient(135deg,#0A1929 0%,#102A43 100%);color:#ffffff;padding:32px 20px;text-align:center;border-bottom:4px solid #00C48C;">
    <div style="font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;opacity:0.8;">ModernTax · ERC Refund Recovery</div>
    <h1 style="margin:0;font-size:22px;font-weight:600;letter-spacing:-0.5px;">${ent.entity_name}</h1>
  </div>
  <div style="padding:32px 36px;color:#1a1a1a;font-size:15px;">
    <p>Hi Alex,</p>
    <p>Great connecting today. Here's everything we found in Mento's IRS account — and the status page is live where you can track every step of the recovery process in real time.</p>

    <table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14px;">
      <thead><tr style="background:#f5f5f5;">
        <th style="padding:8px 12px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#666;">Quarter</th>
        <th style="padding:8px 12px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#666;">Issued</th>
        <th style="padding:8px 12px;text-align:right;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#666;">Returned to IRS</th>
      </tr></thead>
      <tbody>${quartersRows}</tbody>
      <tfoot><tr style="background:#f5f5f5;">
        <td style="padding:8px 12px;font-weight:600;">Total recoverable</td><td></td>
        <td style="padding:8px 12px;text-align:right;font-weight:700;color:#00C48C;">${usd(rec.total_undelivered)}</td>
      </tr></tfoot>
    </table>

    <p><strong>Your live status page (bookmark this):</strong></p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${statusUrl}" style="display:inline-block;background-color:#00C48C;color:#ffffff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">View your status page →</a>
    </p>
    <p style="font-size:12px;color:#666;text-align:center;word-break:break-all;"><a href="${statusUrl}" style="color:#00C48C;">${statusUrl}</a></p>

    <p><strong>Two things from you to keep us on track for Monday:</strong></p>
    <ol>
      <li><strong>Pay the Mercury invoice</strong> I sent separately ($1,479, covers everything end-to-end).</li>
      <li><strong>Reply to this email with the mailing address</strong> you want the IRS to send replacement checks to. As we discussed — use any address you can physically check (business, residence, or a trusted recipient). The first checks were returned because the address on file is stale.</li>
    </ol>

    <p>Both done before Monday morning = our expert calls the IRS Business &amp; Specialty Tax Line at 7 AM ET to initiate the trace. Replacement checks for returned-check cases typically arrive in 3–6 weeks.</p>

    <p>The status page updates in real time. You'll get an email at every stage change.</p>

    <p>Reply or text anytime — I'm in the inbox daily.</p>
    <p style="margin-top:24px;">— Matt</p>
  </div>
  <div style="padding:16px;text-align:center;font-size:11px;color:#999;background-color:#fafafa;border-top:1px solid #eee;">
    ModernTax · <a href="mailto:matt@moderntax.io" style="color:#999;">matt@moderntax.io</a>
  </div>
</div>
</body></html>`;

await sgMail.send({
  to: ALEX_EMAIL,
  from: { email: FROM, name: 'Matt Parker · ModernTax' },
  subject: `${ent.entity_name} — ${usd(rec.total_undelivered)} ERC recovery: your status page is live`,
  html,
  replyTo: 'matt@moderntax.io',
});
console.log(`✓ Email sent to ${ALEX_EMAIL}`);
console.log(`   Status URL: ${statusUrl}`);
