'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Generate a unique session ID for the browser session.
 * Persists across page navigations but not across browser sessions.
 */
function getSessionId(): string {
  if (typeof window === 'undefined') return '';

  let sessionId = sessionStorage.getItem('mt_session_id');
  if (!sessionId) {
    sessionId = `s_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    sessionStorage.setItem('mt_session_id', sessionId);
  }
  return sessionId;
}

/**
 * Track a page view or event via the analytics API
 */
async function trackPageView(path: string, referrer?: string): Promise<void> {
  try {
    await fetch('/api/analytics/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'page_view',
        path,
        referrer: referrer || document.referrer || undefined,
        sessionId: getSessionId(),
      }),
    });
  } catch {
    // Analytics should never break the app
  }
}

/**
 * Analytics page view tracker component.
 * Add to the root layout to automatically track all page views.
 *
 * Usage in layout.tsx:
 *   <Analytics />
 */
export function Analytics() {
  const pathname = usePathname();
  const previousPath = useRef<string | null>(null);
  const sessionTracked = useRef(false);

  useEffect(() => {
    // Track session start on first render
    if (!sessionTracked.current) {
      sessionTracked.current = true;
      fetch('/api/analytics/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'session_start',
          path: pathname,
          sessionId: getSessionId(),
        }),
      }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    // Don't track the same path twice in a row
    if (pathname === previousPath.current) return;

    const referrer = previousPath.current || undefined;
    previousPath.current = pathname;

    trackPageView(pathname, referrer);
  }, [pathname]);

  return null; // This component renders nothing
}
