/**
 * Trial welcome unsubscribe endpoint.
 *
 * Supports both GET (user clicks link in email) and POST (RFC 8058 one-click
 * unsubscribe from inbox providers). Token is HMAC-signed, no DB lookup
 * needed to authenticate — we just verify the signature, then write an
 * audit_log row so the drip cron sees the opt-out.
 *
 * Public endpoint — no auth. Safe because:
 *   • Token is signed; an attacker can't forge one without UNSUBSCRIBE_SECRET.
 *   • Acting on a forged/valid token just stops emails — no data exposure.
 *   • Written to audit_log, which is monitored.
 */

import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { verifyUnsubscribeToken } from '@/lib/unsubscribe-tokens';

async function handleUnsubscribe(token: string | null): Promise<Response> {
  if (!token) {
    return htmlResponse(
      'Unsubscribe link invalid',
      'This link is missing a token. Reply to the email and we\'ll remove you manually.',
      400,
    );
  }

  const decoded = verifyUnsubscribeToken(token);
  if (!decoded || decoded.purpose !== 'trial_welcome') {
    return htmlResponse(
      'Unsubscribe link invalid or expired',
      'We couldn\'t verify this unsubscribe link. Reply to the email and we\'ll remove you manually.',
      400,
    );
  }

  const admin = createAdminClient();

  // Look up the profile for display purposes (email, name).
  const { data: profile } = await admin
    .from('profiles')
    .select('email, full_name')
    .eq('id', decoded.profileId)
    .single() as { data: { email: string; full_name: string | null } | null; error: any };

  // Write the opt-out event. The cron checks for this action name before firing
  // the next email. Idempotent — writing twice is harmless.
  await admin.from('audit_log' as any).insert({
    user_email: profile?.email || '',
    action: 'settings_changed',
    entity_type: 'profile',
    entity_id: decoded.profileId,
    details: {
      action: 'trial_welcome_unsubscribed',
      unsubscribed_at: new Date().toISOString(),
      source: 'email_link',
    },
  });

  return htmlResponse(
    'You\'re unsubscribed',
    `We won't send any more trial reminder emails${profile?.email ? ` to <strong>${profile.email}</strong>` : ''}. You'll still receive transcript notifications and account emails. Changed your mind? Just reply to any previous email from us.`,
    200,
  );
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  return handleUnsubscribe(token);
}

/** RFC 8058 one-click POST — Gmail, Apple, etc. call this directly from inbox. */
export async function POST(request: NextRequest) {
  // Token can come from query string or form body (mail clients vary).
  const url = request.nextUrl;
  let token: string | null = url.searchParams.get('token');
  if (!token) {
    const form = await request.formData().catch(() => null);
    if (form) token = (form.get('token') as string) || null;
  }
  return handleUnsubscribe(token);
}

/** Minimal self-contained HTML response so the user lands on a page that confirms the action. */
function htmlResponse(title: string, bodyHtml: string, status: number): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} — ModernTax</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 64px auto; padding: 0 20px; color: #1f2937; line-height: 1.6; }
  h1 { font-size: 22px; color: #1e3a5f; margin: 0 0 12px; }
  p  { font-size: 14px; margin: 0 0 12px; }
  a  { color: #2563eb; }
  .card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 24px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
</style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${bodyHtml}</p>
    <p style="margin-top:20px;"><a href="https://portal.moderntax.io">← portal.moderntax.io</a></p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
