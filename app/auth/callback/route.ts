import { createServerClient } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';

/**
 * SOC 2 CC6.1 — validate a post-auth redirect target is same-origin.
 * Rejects:
 *   - protocol-relative URLs ("//evil.com" → would redirect to evil.com)
 *   - backslash-prefix tricks ("/\\evil.com")
 *   - absolute URLs ("https://evil.com/")
 *   - anything that doesn't start with a single "/"
 * Falls back to "/" on rejection.
 */
function safeNextPath(raw: string | null): string {
  if (!raw || typeof raw !== 'string') return '/';
  // Must start with `/` and not `//` or `/\`
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  // Defense-in-depth: ensure parsing it against the origin doesn't escape.
  try {
    const parsed = new URL(raw, 'https://portal.moderntax.io');
    if (parsed.origin !== 'https://portal.moderntax.io') return '/';
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return '/';
  }
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const next = safeNextPath(requestUrl.searchParams.get('next'));

  if (code) {
    // Create the redirect response FIRST, then set cookies on it
    const redirectTo = `${requestUrl.origin}${next}`;
    const response = NextResponse.redirect(redirectTo);

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => {
              response.cookies.set(name, value, options);
            });
          },
        },
      }
    );

    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      return response;
    }

    console.error('Auth callback error:', error);
  }

  // If no code or error, redirect to login with error
  return NextResponse.redirect(`${requestUrl.origin}/login?error=auth`);
}
