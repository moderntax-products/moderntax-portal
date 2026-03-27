'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || 'Something went wrong. Please try again.');
      } else {
        setSubmitted(true);
      }
    } catch {
      setError('An unexpected error occurred. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-mt-dark to-mt-navy flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Logo/Branding */}
        <div className="mb-10 text-center">
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
        </div>

        {/* Main Card */}
        <div className="bg-white rounded-lg shadow-lg p-8">
          {submitted ? (
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-16 h-16 bg-mt-green bg-opacity-10 rounded-full mb-4">
                <svg
                  className="w-8 h-8 text-mt-green"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                  />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-mt-dark mb-2">Check your email</h2>
              <p className="text-gray-600 mb-4">
                If an account exists for{' '}
                <span className="font-semibold text-mt-dark">{email}</span>,
                we&apos;ve sent a password reset link.
              </p>
              <p className="text-sm text-gray-500 mb-6">
                The link will expire in 24 hours. Check your spam folder if you don&apos;t see the email.
              </p>
              <Link
                href="/login"
                className="text-mt-green hover:text-opacity-80 font-medium text-sm transition-colors"
              >
                Back to Sign In
              </Link>
            </div>
          ) : (
            <>
              <h2 className="text-2xl font-bold text-mt-dark mb-2">Reset your password</h2>
              <p className="text-gray-500 text-sm mb-6">
                Enter your email address and we&apos;ll send you a link to reset your password.
              </p>

              {error && (
                <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-red-700 text-sm">{error}</p>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
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
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-mt-green text-white py-3 rounded-lg font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isLoading ? 'Sending...' : 'Send Reset Link'}
                </button>
              </form>

              <p className="mt-6 text-center text-sm text-gray-500">
                Remember your password?{' '}
                <Link href="/login" className="text-mt-green hover:underline font-medium">
                  Sign in
                </Link>
              </p>
            </>
          )}
        </div>

        {/* Footer */}
        <p className="mt-8 text-center text-sm text-gray-400">
          &copy; 2026 ModernTax. All rights reserved.
        </p>
      </div>
    </div>
  );
}
