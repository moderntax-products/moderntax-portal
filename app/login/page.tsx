'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Handle error from URL params
  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get('error') === 'auth') {
      setError('Authentication failed. Please try again.');
      window.history.replaceState(null, '', window.location.pathname);
    }
    if (searchParams.get('reset') === 'success') {
      setSuccess('Your password has been reset. Please sign in with your new password.');
      window.history.replaceState(null, '', window.location.pathname);
    }
    if (searchParams.get('signup') === 'success') {
      setSuccess('Account created successfully! Sign in with your credentials.');
      window.history.replaceState(null, '', window.location.pathname);
    }
    // Pending-approval bounce from the dashboard server component —
    // user signed up but admin hasn't approved yet, so the login screen
    // shows a friendly status banner instead of letting them re-attempt
    // sign-in (which would just bounce them back).
    if (searchParams.get('status') === 'pending-review') {
      setError('Your account is awaiting admin approval. We review every new sign-up to set up your account for the right use case (SBA, employment, insurance, or other) — usually within one business day. Questions? Email matt@moderntax.io.');
      window.history.replaceState(null, '', window.location.pathname);
    }
    if (searchParams.get('status') === 'rejected') {
      setError('Your sign-up was not approved. If you believe this is an error, reply to your sign-up confirmation email or contact matt@moderntax.io.');
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  // SSO via Google / Microsoft (Supabase OAuth). Redirects to the provider,
  // which returns to /auth/callback to exchange the code. Delegated auth means
  // the IdP's own MFA + device policies protect the login.
  const handleOAuth = async (provider: 'google' | 'azure') => {
    setError(null);
    setSuccess(null);
    setIsLoading(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
          scopes: provider === 'azure' ? 'openid email profile' : undefined,
        },
      });
      if (error) {
        setError(error.message || 'Could not start sign-in. Please try again.');
        setIsLoading(false);
      }
      // On success the browser navigates to the provider — no further action here.
    } catch {
      setError('Could not start sign-in. Please try again.');
      setIsLoading(false);
    }
  };

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setIsLoading(true);

    try {
      // Use server-side API route to handle login — sets cookies on the server response
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || 'Sign in failed.');
      } else {
        // Cookies are now set by the server — navigate to dashboard
        window.location.href = '/';
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-mt-dark to-mt-navy flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Logo/Branding */}
        <div className="mb-10 text-center">
          {/* ModernTax Logo */}
          <div className="flex items-center justify-center gap-3 mb-4">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="24" cy="24" r="24" fill="#3B82F6" />
              <text
                x="24"
                y="30"
                textAnchor="middle"
                fontFamily="monospace"
                fontWeight="bold"
                fontSize="20"
                fill="#FFFFFF"
              >
                {'</>'}
              </text>
            </svg>
            <h1 className="text-4xl font-bold text-white tracking-tight">ModernTax</h1>
          </div>
          <p className="text-gray-300 text-sm">IRS Transcript Verification Portal</p>
          <div className="flex items-center justify-center gap-2 mt-3">
            <svg className="w-4 h-4 text-mt-green" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
            </svg>
            <span className="text-xs text-gray-400">SOC 2 Compliant &middot; 256-bit Encryption</span>
          </div>
        </div>

        {/* Main Card */}
        <div className="bg-white rounded-lg shadow-lg p-8">
          <h2 className="text-2xl font-bold text-mt-dark mb-6">Sign in to your account</h2>

          {error && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-700 text-sm">{error}</p>
            </div>
          )}

          {success && (
            <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg">
              <p className="text-green-700 text-sm">{success}</p>
            </div>
          )}

          <form onSubmit={handlePasswordLogin} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-mt-dark mb-2">
                Email Address
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                required
                disabled={isLoading}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <label htmlFor="password" className="block text-sm font-medium text-mt-dark">
                  Password
                </label>
                <Link
                  href="/forgot-password"
                  className="text-sm text-mt-green hover:underline"
                >
                  Forgot password?
                </Link>
              </div>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                required
                disabled={isLoading}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>
            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-mt-green text-white py-3 rounded-lg font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>

          {/* SSO — Google + Microsoft */}
          <div className="mt-5 flex items-center gap-3">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-xs text-gray-400 uppercase tracking-wide">or continue with</span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>
          <div className="mt-4 space-y-2">
            <button
              type="button"
              onClick={() => handleOAuth('google')}
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-2 border border-gray-300 bg-white text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.34A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.02-2.34z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.02 2.34C4.68 5.16 6.66 3.58 9 3.58z"/></svg>
              Continue with Google
            </button>
            <button
              type="button"
              onClick={() => handleOAuth('azure')}
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-2 border border-gray-300 bg-white text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg width="16" height="16" viewBox="0 0 23 23" aria-hidden="true"><path fill="#F25022" d="M1 1h10v10H1z"/><path fill="#7FBA00" d="M12 1h10v10H12z"/><path fill="#00A4EF" d="M1 12h10v10H1z"/><path fill="#FFB900" d="M12 12h10v10H12z"/></svg>
              Continue with Microsoft
            </button>
          </div>

          {/* Signup Link */}
          <p className="mt-6 text-center text-sm text-gray-600">
            Don&apos;t have an account?{' '}
            <Link href="/signup" className="text-mt-green font-semibold hover:underline">
              Sign up
            </Link>
          </p>

          {/* Help Text */}
          <p className="mt-4 text-center text-sm text-gray-500">
            For support, contact{' '}
            <a href="mailto:support@moderntax.io" className="text-mt-green hover:underline">
              support@moderntax.io
            </a>
          </p>
        </div>

        {/* Footer */}
        <p className="mt-8 text-center text-sm text-gray-400">
          © 2026 ModernTax. All rights reserved.
        </p>
      </div>
    </div>
  );
}
