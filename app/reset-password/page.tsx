'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase';
import Link from 'next/link';

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const supabase = createClient();

  const verifyToken = useCallback(async () => {
    const searchParams = new URLSearchParams(window.location.search);
    const tokenHash = searchParams.get('token_hash');
    const type = searchParams.get('type');

    if (tokenHash && type === 'recovery') {
      // Verify the recovery token directly — no redirect needed
      const { error: verifyError } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: 'recovery',
      });

      // Clean the URL regardless of result
      window.history.replaceState(null, '', window.location.pathname);

      if (!verifyError) {
        setIsAuthenticated(true);
        return;
      }

      console.error('Token verification error:', verifyError);
      setIsAuthenticated(false);
      return;
    }

    // No token in URL — check for existing recovery session
    const { data: { session } } = await supabase.auth.getSession();
    setIsAuthenticated(!!session);
  }, [supabase.auth]);

  useEffect(() => {
    verifyToken();
  }, [verifyToken]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError('Password must be at least 8 characters long.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setIsLoading(true);

    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password: password,
      });

      if (updateError) {
        setError(updateError.message);
      } else {
        setSuccess(true);
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
          {success ? (
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
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-mt-dark mb-2">Password updated</h2>
              <p className="text-gray-600 mb-6">
                Your password has been successfully reset. You can now sign in with your new password.
              </p>
              <Link
                href="/login"
                className="inline-block bg-mt-green text-white px-6 py-3 rounded-lg font-semibold hover:bg-opacity-90 transition-colors"
              >
                Sign In
              </Link>
            </div>
          ) : isAuthenticated === false ? (
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-16 h-16 bg-red-50 rounded-full mb-4">
                <svg
                  className="w-8 h-8 text-red-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z"
                  />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-mt-dark mb-2">Invalid or expired link</h2>
              <p className="text-gray-600 mb-6">
                This password reset link has expired or is invalid. Please request a new one.
              </p>
              <Link
                href="/forgot-password"
                className="inline-block bg-mt-green text-white px-6 py-3 rounded-lg font-semibold hover:bg-opacity-90 transition-colors"
              >
                Request New Link
              </Link>
            </div>
          ) : isAuthenticated === null ? (
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mt-green mx-auto"></div>
              <p className="text-gray-500 mt-4 text-sm">Verifying your reset link...</p>
            </div>
          ) : (
            <>
              <h2 className="text-2xl font-bold text-mt-dark mb-2">Set new password</h2>
              <p className="text-gray-500 text-sm mb-6">
                Enter your new password below. Must be at least 8 characters.
              </p>

              {error && (
                <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-red-700 text-sm">{error}</p>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="password" className="block text-sm font-medium text-mt-dark mb-2">
                    New Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter new password"
                    required
                    minLength={8}
                    disabled={isLoading}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                </div>
                <div>
                  <label htmlFor="confirm-password" className="block text-sm font-medium text-mt-dark mb-2">
                    Confirm New Password
                  </label>
                  <input
                    id="confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm new password"
                    required
                    minLength={8}
                    disabled={isLoading}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                </div>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-mt-green text-white py-3 rounded-lg font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isLoading ? 'Updating...' : 'Update Password'}
                </button>
              </form>
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
