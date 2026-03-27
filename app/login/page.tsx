'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

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
  }, []);

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
