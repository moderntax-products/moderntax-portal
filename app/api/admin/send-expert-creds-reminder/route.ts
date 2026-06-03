/**
 * POST /api/admin/send-expert-creds-reminder
 *
 * Sends every expert a personalized transactional email asking them to update
 * their profile / confirm their IRS designee credentials (CAF, PTIN, daytime
 * phone, address). Experts whose creds are incomplete CANNOT be assigned work
 * under the broadcast (first-to-accept) batch system, so the copy is tailored:
 *   - incomplete → "you can't be assigned work until you add: …"
 *   - complete   → "please confirm these are current"
 *
 * Reply-to matt@moderntax.io. Auth: CRON_SECRET.
 * Body (optional): { dryRun?: boolean, only?: string[] (emails) }
 */

import { NextRequest, NextResponse } from 'next/server';
import sgMail from '@sendgrid/mail';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROFILE_URL = 'https://portal.moderntax.io/expert/profile';

const FIELD_LABEL: Record<string, string> = {
  caf_number: 'CAF number',
  ptin: 'PTIN',
  phone_number: 'Daytime phone number',
  address: 'Mailing address',
};

export async function POST(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;
  if (!process.env.SENDGRID_API_KEY) {
    return NextResponse.json({ error: 'SENDGRID_API_KEY not configured' }, { status: 500 });
  }

  let body: { dryRun?: boolean; only?: string[] } = {};
  try { body = await request.json(); } catch { /* no body */ }
  const dryRun = body.dryRun === true;
  const onlyEmails = Array.isArray(body.only) ? body.only.map((e) => e.toLowerCase()) : null;

  const admin = createAdminClient();
  const { data: experts } = await admin
    .from('profiles')
    .select('id, full_name, email, caf_number, ptin, phone_number, address')
    .eq('role', 'expert') as { data: any[] | null };

  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const results: Array<{ email: string; name: string; missing: string[]; sent: boolean; error?: string }> = [];

  for (const e of experts || []) {
    if (!e.email) { results.push({ email: '(none)', name: e.full_name || '?', missing: [], sent: false, error: 'no email' }); continue; }
    if (onlyEmails && !onlyEmails.includes(e.email.toLowerCase())) continue;

    const required = ['caf_number', 'ptin', 'phone_number', 'address'];
    const missing = required.filter((f) => !(e[f] && String(e[f]).trim()));
    const firstName = (e.full_name || '').trim().split(/\s+/)[0] || 'there';
    const incomplete = missing.length > 0;

    const missingList = missing.map((f) => FIELD_LABEL[f]).join(', ');
    const subject = incomplete
      ? 'Action needed: complete your ModernTax expert profile'
      : 'Quick check: confirm your ModernTax designee credentials';

    const bodyHtml = incomplete
      ? `<p>Hi ${firstName},</p>
<p>We've moved to a <strong>first-to-accept</strong> assignment system — IRS verification work is now offered to all credentialed experts at once, and the first to accept gets it. The catch: <strong>your profile is missing required designee credentials, so you can't be offered or accept work yet.</strong></p>
<p>Still needed on your profile:</p>
<ul>${missing.map((f) => `<li><strong>${FIELD_LABEL[f]}</strong></li>`).join('')}</ul>
<p style="margin:22px 0;"><a href="${PROFILE_URL}" style="display:inline-block;background:#00c48c;color:#fff;padding:12px 26px;border-radius:8px;text-decoration:none;font-weight:700;">Complete my profile &rarr;</a></p>
<p>Once these are in, you'll immediately start receiving batch assignments. Your CAF + PTIN are also what get stamped on the Form 8821 as the designee, so they have to be accurate.</p>`
      : `<p>Hi ${firstName},</p>
<p>We've moved to a <strong>first-to-accept</strong> assignment system — IRS verification work is now offered to all credentialed experts at once, and the first to accept it gets it. Your 8821 designee credentials are generated from your profile, so it's worth a 30-second check that they're current.</p>
<p style="margin:22px 0;"><a href="${PROFILE_URL}" style="display:inline-block;background:#00c48c;color:#fff;padding:12px 26px;border-radius:8px;text-decoration:none;font-weight:700;">Review my profile &rarr;</a></p>
<p>Please confirm your <strong>CAF number, PTIN, daytime phone, and mailing address</strong> are accurate — these are what get stamped on every Form 8821 you're the designee on.</p>`;

    const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a2845;line-height:1.55;">${bodyHtml}<p>Thanks,<br/>Matt &middot; ModernTax</p></div>`;
    const text = incomplete
      ? `Hi ${firstName},\n\nWe've moved to a first-to-accept assignment system. Your profile is missing required designee credentials, so you can't be offered work yet. Still needed: ${missingList}.\n\nComplete your profile: ${PROFILE_URL}\n\nOnce these are in you'll start receiving assignments. Your CAF + PTIN are stamped on the 8821 as designee.\n\nThanks,\nMatt · ModernTax`
      : `Hi ${firstName},\n\nWe've moved to a first-to-accept assignment system. Please take 30 seconds to confirm your designee credentials (CAF number, PTIN, daytime phone, mailing address) are current — they're stamped on every Form 8821 you're the designee on.\n\nReview your profile: ${PROFILE_URL}\n\nThanks,\nMatt · ModernTax`;

    if (dryRun) { results.push({ email: e.email, name: e.full_name || '?', missing, sent: false }); continue; }

    try {
      await sgMail.send({
        to: e.email,
        from: { email: 'no-reply@moderntax.io', name: 'ModernTax' },
        replyTo: 'matt@moderntax.io',
        subject,
        html,
        text,
      });
      results.push({ email: e.email, name: e.full_name || '?', missing, sent: true });
    } catch (err: any) {
      results.push({ email: e.email, name: e.full_name || '?', missing, sent: false, error: err?.response?.body?.errors?.[0]?.message || err?.message || String(err) });
    }
  }

  return NextResponse.json({ success: true, dryRun, count: results.length, results });
}
