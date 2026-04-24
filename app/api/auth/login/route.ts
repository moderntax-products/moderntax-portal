import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { logAuditFromRequest } from '@/lib/audit';
import { trackFromRequest } from '@/lib/analytics';
import { createAdminClient } from '@/lib/supabase-server';
import { consumeRateLimit, getClientIp } from '@/lib/rate-limit';

export async function POST(request: NextRequest) {
  // SOC 2 CC6.1 — brute-force protection. Tighter per-IP + per-email buckets
  // than Supabase's default so we catch credential-stuffing at the API edge.
  const clientIp = getClientIp(request);
  const { email, password } = await request.json();

  const ipLimit = consumeRateLimit(clientIp, 'auth:login:ip', {
    max: 20, windowMs: 60_000, // 20 logins/min per IP
  });
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many login attempts from this IP. Please wait and try again.' },
      { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfter) } },
    );
  }
  if (typeof email === 'string' && email.length > 0) {
    const emailKey = email.trim().toLowerCase();
    const emailLimit = consumeRateLimit(emailKey, 'auth:login:email', {
      max: 10, windowMs: 60_000, // 10 attempts/min per email
    });
    if (!emailLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many login attempts for this account. Please wait and try again.' },
        { status: 429, headers: { 'Retry-After': String(emailLimit.retryAfter) } },
      );
    }
  }

  const cookieStore = await cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, {
              ...options,
              // SOC 2: Enforce secure cookie flags
              // NOTE: httpOnly must NOT be set to true here.
              // @supabase/ssr's createBrowserClient reads cookies via document.cookie,
              // which requires httpOnly=false (the library's default).
              // CSP headers mitigate XSS risks that httpOnly would address.
              secure: process.env.NODE_ENV === 'production',
              sameSite: 'lax' as const,
            });
          });
        },
      },
    }
  );

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    // SOC 2: Log failed login attempts
    await logAuditFromRequest(supabase, request, {
      action: 'login_failed',
      resourceType: 'auth',
      details: { email, reason: error.message },
    });
    // Analytics: track failed login
    const adminClient = createAdminClient();
    await trackFromRequest(adminClient, request, {
      type: 'login_failed',
      userEmail: email,
      metadata: { reason: error.message },
    });
    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  // SOC 2: Log successful login
  await logAuditFromRequest(supabase, request, {
    action: 'login',
    resourceType: 'auth',
    details: { email, method: 'password' },
  });

  // Analytics: track successful login
  const adminClient = createAdminClient();
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, client_id')
    .eq('id', data.user?.id || '')
    .single();

  await trackFromRequest(adminClient, request, {
    type: 'login',
    userId: data.user?.id,
    userEmail: email,
    userRole: profile?.role || undefined,
    clientId: profile?.client_id || undefined,
    metadata: { method: 'password' },
  });

  return NextResponse.json({ success: true, user: data.user?.email });
}
