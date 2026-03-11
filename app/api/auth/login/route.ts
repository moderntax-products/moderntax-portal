import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { logAuditFromRequest } from '@/lib/audit';

export async function POST(request: NextRequest) {
  const { email, password } = await request.json();

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
              httpOnly: true,
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
    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  // SOC 2: Log successful login
  await logAuditFromRequest(supabase, request, {
    action: 'login',
    resourceType: 'auth',
    details: { email, method: 'password' },
  });

  return NextResponse.json({ success: true, user: data.user?.email });
}
