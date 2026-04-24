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
