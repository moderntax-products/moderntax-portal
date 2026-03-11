import { createServerClient } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';

/**
 * SOC 2 Compliant Security Headers
 * Applied to every response via middleware
 */
function applySecurityHeaders(response: NextResponse): NextResponse {
  // Prevent clickjacking
  response.headers.set('X-Frame-Options', 'DENY');

  // Prevent MIME type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // Enable XSS protection (legacy browsers)
  response.headers.set('X-XSS-Protection', '1; mode=block');

  // Strict Transport Security (HSTS) — enforce HTTPS, 1 year
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains; preload'
  );

  // Referrer Policy — don't leak sensitive URLs
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions Policy — restrict sensitive browser APIs
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()'
  );

  // Content Security Policy — restrict content sources
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';

  const cspDirectives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${supabaseUrl} https://*.supabase.co wss://*.supabase.co`,
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "object-src 'none'",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  response.headers.set('Content-Security-Policy', cspDirectives.join('; '));

  // Prevent caching of sensitive pages
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  response.headers.set('Pragma', 'no-cache');

  return response;
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, {
              ...options,
              // SOC 2: Enforce secure cookie flags
              httpOnly: true,
              secure: process.env.NODE_ENV === 'production',
              sameSite: 'lax',
            })
          );
        },
      },
    }
  );

  // IMPORTANT: Do not use getSession() — use getUser() for security
  // This also refreshes the session cookie if needed
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // If no user and not on login/auth/api pages, redirect to login
  if (
    !user &&
    !request.nextUrl.pathname.startsWith('/login') &&
    !request.nextUrl.pathname.startsWith('/auth') &&
    !request.nextUrl.pathname.startsWith('/api/')
  ) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    const redirectResponse = NextResponse.redirect(url);
    return applySecurityHeaders(redirectResponse);
  }

  // Apply SOC 2 security headers to all responses
  return applySecurityHeaders(supabaseResponse);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
