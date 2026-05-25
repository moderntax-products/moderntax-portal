/**
 * Expert IRS PPS credentials — SSN + DOB.
 *
 * POST /api/expert/credentials
 *   Expert sets or updates their own SSN + DOB. Both fields required.
 *   Explicit consent flag ("confirm you authorize use during IRS AI calls")
 *   must be true to commit. Creates an audit_log entry.
 *
 * GET /api/expert/credentials
 *   Returns only presence flags ({ hasSsn, hasDob, consentedAt, updatedAt }).
 *   NEVER returns the actual SSN/DOB — there is no endpoint that does, ever.
 *
 * DELETE /api/expert/credentials
 *   Expert removes their stored credentials. Audited. After deletion, IRS
 *   calls that attempt to initiate will fail loud with "credentials
 *   missing" until the expert re-sets them.
 *
 * Decryption is done server-side only in lib/voice-provider.initiateCall().
 * These are never sent to any browser.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createHash } from 'crypto';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { encryptCredential, normalizeSSN, normalizeDOB } from '@/lib/crypto';

export const runtime = 'nodejs';

export async function GET() {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  const { data: profile } = await (admin.from('profiles' as any) as any)
    .select('ssn_encrypted, dob_encrypted, irs_credentials_updated_at, irs_credentials_consented_at, irs_credentials_used_count')
    .eq('id', user.id)
    .single();

  return NextResponse.json({
    hasSsn: !!(profile && profile.ssn_encrypted),
    hasDob: !!(profile && profile.dob_encrypted),
    consentedAt: profile?.irs_credentials_consented_at || null,
    updatedAt: profile?.irs_credentials_updated_at || null,
    usedCount: profile?.irs_credentials_used_count || 0,
  });
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  // Only experts need these — managers/processors/admins don't dial IRS PPS.
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (!profile || profile.role !== 'expert') {
    return NextResponse.json({ error: 'Only expert accounts can store IRS credentials' }, { status: 403 });
  }

  let body: { ssn?: string; dob?: string; consent?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.ssn || !body.dob) {
    return NextResponse.json({ error: 'ssn and dob are required' }, { status: 400 });
  }
  if (body.consent !== true) {
    return NextResponse.json(
      { error: 'Explicit consent is required. Set "consent": true to confirm these will be used for IRS PPS authentication during AI-led calls on your behalf.' },
      { status: 400 },
    );
  }

  let ssnClean: string, dobClean: string;
  try {
    ssnClean = normalizeSSN(body.ssn);
    dobClean = normalizeDOB(body.dob);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Validation failed' }, { status: 400 });
  }

  // Encrypt + persist. Use service role so RLS on the sensitive columns doesn't block writes.
  const admin = createAdminClient();
  const ssnEncrypted = encryptCredential(ssnClean);
  const dobEncrypted = encryptCredential(dobClean);
  const now = new Date().toISOString();

  // Capture the BEFORE state so we know if this is a first-time setup
  // (vs a credential rotation). First-time triggers an admin email so
  // Matt can update the expert's 8821 template + start routing work
  // — without it, the expert sits idle waiting for an admin to notice.
  const { data: priorProfile } = await (admin.from('profiles' as any) as any)
    .select('full_name, email, ssn_encrypted, irs_credentials_consented_at, caf_number, fax_number, address, city, state, zip_code, sor_id')
    .eq('id', user.id)
    .single();
  const isFirstTimeConsent = !priorProfile?.ssn_encrypted && !priorProfile?.irs_credentials_consented_at;

  const { error: upErr } = await (admin.from('profiles' as any) as any)
    .update({
      ssn_encrypted: ssnEncrypted,
      dob_encrypted: dobEncrypted,
      irs_credentials_updated_at: now,
      irs_credentials_consented_at: now,
    })
    .eq('id', user.id);

  if (upErr) {
    console.error('[credentials] update failed:', upErr.message);
    return NextResponse.json({ error: 'Failed to save credentials' }, { status: 500 });
  }

  // Fire the admin notification AFTER successful persist. Non-blocking on
  // failure — credentials are saved either way; missing email is a
  // ops-paper-cut, not a data integrity issue.
  if (isFirstTimeConsent) {
    notifyAdminOfCompletedCredentials(priorProfile).catch(err =>
      console.warn('[credentials] admin notification failed (non-fatal):', err?.message || err),
    );
  }

  await logAuditFromRequest(admin, request, {
    action: 'irs_credentials_updated',
    userId: user.id,
    userEmail: user.email || '',
    resourceType: 'profile',
    resourceId: user.id,
    details: {
      consented: true,
      // Never log the actual values. Store hashes so we can later tell "did they change?" without seeing.
      ssn_fingerprint: fingerprint(ssnClean),
      dob_fingerprint: fingerprint(dobClean),
    },
  });

  return NextResponse.json({ success: true, updatedAt: now });
}

export async function DELETE(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  await (admin.from('profiles' as any) as any)
    .update({
      ssn_encrypted: null,
      dob_encrypted: null,
      irs_credentials_updated_at: new Date().toISOString(),
      irs_credentials_consented_at: null,
    })
    .eq('id', user.id);

  await logAuditFromRequest(admin, request, {
    action: 'irs_credentials_deleted',
    userId: user.id,
    userEmail: user.email || '',
    resourceType: 'profile',
    resourceId: user.id,
    details: {},
  });

  return NextResponse.json({ success: true });
}

/**
 * 8-char SHA-256 prefix — lets us tell "did the credential value change?"
 * across audit events without being reversible into the plaintext.
 */
function fingerprint(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

/**
 * Fire-and-forget admin notification — runs when an expert sets their
 * IRS credentials for the FIRST time (consent was previously null).
 *
 * Trigger context: Matt asked 2026-05-23 — when Joel completes his
 * credentials setup, send an admin email so the 8821 template can be
 * updated same-day and the expert starts getting routed work without
 * sitting idle. Same mechanism will apply to any future expert
 * (Brian, Katie, etc.) the first time they complete the form.
 *
 * Body lists every 8821-relevant field on the profile so Matt can
 * eyeball gaps before assigning work (missing fax, missing SOR, etc.).
 * SSN/DOB themselves are NEVER included — only presence flags.
 */
async function notifyAdminOfCompletedCredentials(prior: any): Promise<void> {
  // Lazy import — sendgrid sdk pulls a lot; keep cold-start lean for the
  // credentials endpoint's hot path.
  const sgMod = await import('@sendgrid/mail');
  const sgMail = sgMod.default;
  const key = process.env.SENDGRID_API_KEY;
  if (!key) {
    console.warn('[credentials] SENDGRID_API_KEY not set — skipping admin notification');
    return;
  }
  sgMail.setApiKey(key);

  const expertName = prior?.full_name || '(unknown name)';
  const expertEmail = prior?.email || '(unknown email)';
  const gaps: string[] = [];
  if (!prior?.fax_number) gaps.push('fax_number (required for transcript routing)');
  if (!prior?.sor_id)     gaps.push('sor_id (required for transcript upload destination)');
  if (!prior?.city || !prior?.state || !prior?.zip_code) {
    gaps.push('full address (city/state/zip missing)');
  }
  if (!prior?.caf_number) gaps.push('caf_number');

  const profileFields = [
    ['Name',     expertName],
    ['Email',    expertEmail],
    ['CAF',      prior?.caf_number || '(missing)'],
    ['Phone',    prior?.phone_number || '(missing)'],
    ['Fax',      prior?.fax_number || '(missing)'],
    ['Address',  [prior?.address, prior?.city, prior?.state, prior?.zip_code].filter(Boolean).join(', ') || '(missing)'],
    ['SOR ID',   prior?.sor_id || '(missing)'],
    ['SSN/DOB',  '✓ encrypted on file (just completed)'],
    ['Consent',  '✓ given just now'],
  ];

  const html = `
<div style="font-family:-apple-system,sans-serif;max-width:600px;line-height:1.5;color:#1a2845;">
  <p><strong>${expertName}</strong> just completed their IRS Credentials setup on ModernTax.</p>

  <p>Their 8821 template can now be updated. Profile snapshot:</p>

  <table style="border-collapse:collapse;font-size:14px;">
    ${profileFields.map(([k, v]) => `
      <tr>
        <td style="padding:4px 12px 4px 0;color:#6b7280;">${k}:</td>
        <td style="padding:4px 0;font-family:ui-monospace,monospace;">${String(v).replace(/</g, '&lt;')}</td>
      </tr>`).join('')}
  </table>

  ${gaps.length > 0 ? `
    <p style="margin-top:16px;padding:12px;background:#fef3c7;border-left:3px solid #f59e0b;color:#78350f;">
      <strong>⚠ Still missing for full 8821 readiness:</strong><br>
      ${gaps.map(g => `• ${g.replace(/</g, '&lt;')}`).join('<br>')}
    </p>
  ` : `
    <p style="margin-top:16px;padding:12px;background:#d1fae5;border-left:3px solid #10b981;color:#065f46;">
      <strong>✓ All 8821 fields present.</strong> Safe to route work assignments.
    </p>
  `}

  <p><a href="https://portal.moderntax.io/admin/team" style="color:#295c9e;">Open admin team page →</a></p>
</div>`.trim();

  await sgMail.send({
    to: 'matt@moderntax.io',
    from: { email: 'no-reply@moderntax.io', name: 'ModernTax Portal' },
    subject: `[Action Needed] ${expertName} completed IRS credentials — update 8821 template`,
    html,
    text: `${expertName} (${expertEmail}) just completed their IRS Credentials setup.\n\n` +
      profileFields.map(([k, v]) => `${k}: ${v}`).join('\n') +
      (gaps.length > 0 ? `\n\n⚠ Still missing: ${gaps.join(', ')}` : '\n\n✓ All 8821 fields present.') +
      `\n\nUpdate the 8821 template: https://portal.moderntax.io/admin/team`,
  });
  console.log(`[credentials] admin notified of ${expertName}'s first-time credentials setup`);
}
